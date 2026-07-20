ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Email intake — capture + safely display the body (Phase A of 2)

David is setting up Gmail auto-forwarding to receipts@dazbeez.com. Two
drivers: (1) some receipts arrive in the email BODY with no attachment —
today invisible; (2) Gmail's forwarding-confirmation email has its
verification link in the body — today unrecoverable, since the intake
pipeline discards the body entirely (attachments + headers only, ADR 0011
v1 was explicitly scoped that way).

This phase (A) makes the body visible, safely, with clickable links —
which alone fully solves both stated drivers. **Phase B (separate prompt,
follow-up) adds full auto-promotion of body-only receipts into the books —
do not build any of that here.** Keep this phase's blast radius to
visibility only.

## Decisions already made (do not revisit)

1. Store BOTH `body_text` and `body_html` — text for the safe default view,
   html for fidelity when the operator wants it.
2. Application-level size cap on each (this is NOT because of a specific
   documented Cloudflare/D1 hard limit — none was found; it's a pragmatic
   guard against a pathological huge inline-image-laden HTML body bloating
   the DB and the triage UI): cap `body_text` at 256 KiB, `body_html` at
   512 KiB. Truncate beyond the cap and set a `body_truncated` flag rather
   than rejecting the row — the email is still valid, just not fully
   stored. If you find an actual documented platform ceiling tighter than
   this while implementing, use the tighter one and tell me.
3. **Security-first display.** The email body is fully untrusted,
   attacker-controlled input — receipts@ is a public, unauthenticated
   address, anyone can mail it. Text is the default view (zero injection
   risk). HTML is available behind an explicit per-message toggle,
   rendered ONLY inside a sandboxed `<iframe>` via `srcdoc`, sandbox
   attribute with NO `allow-scripts`, no `allow-same-origin` combined with
   scripts, no `allow-popups`, no `allow-top-navigation`. Never
   `dangerouslySetInnerHTML` the body into the app's own DOM — that would
   let attacker HTML/CSS run inside the authenticated Clerk-gated page.
   Layer DOMPurify sanitization on the html before handing it to the
   iframe's `srcdoc` too (defense in depth on top of the sandbox, not
   instead of it).
4. **Extract links, don't just render and hope David finds them.** This
   directly solves driver #2. Pure helper, testable without DOM/network.

## 1. Migration

`ls db/receipts/*.sql` first to confirm the next number (0026 is already
taken by `0026_amex_foreign_currency.sql` — use whatever comes after the
current highest). New file, additive only:

```sql
ALTER TABLE email_receipt_intake ADD COLUMN body_text TEXT;
ALTER TABLE email_receipt_intake ADD COLUMN body_html TEXT;
ALTER TABLE email_receipt_intake ADD COLUMN body_truncated INTEGER NOT NULL DEFAULT 0;
```

Nullable body columns (older rows never captured a body — stay NULL, no
backfill). `body_truncated` defaults 0/false.

## 2. Worker capture (`workers/receipts-email-intake/src/index.ts`)

`PostalMime.parse()` already exposes `parsed.text` and `parsed.html` —
currently read nowhere. Capture both, apply the caps from decision #2
(truncate + set the flag if exceeded), pass through to `recordIntake`.

## 3. `lib/receipts/email-intake.ts`

- `RecordIntakeInput` gains `bodyText: string | null`, `bodyHtml: string |
  null`, `bodyTruncated: boolean`.
- `recordIntake()`: thread these into BOTH insert branches (the
  zero-attachment §3.5 branch at line ~171 AND the per-attachment branches
  ~190-241) — a body can accompany an email that also has attachments, this
  isn't exclusive to the body-only case. Update the INSERT statement
  (~248-274) and its bind list accordingly.
- `EmailReceiptIntake` type (`lib/receipts/types.ts`) gains the three
  fields to match.

## 4. `lib/receipts/email-parse.ts` (new file) — link extraction

Pure function, no I/O:

```ts
export function extractLinks(bodyText: string | null, bodyHtml: string | null): string[]
```

- Prefer `bodyText` if present (plain URLs are trivial to regex out of
  text); fall back to stripping tags from `bodyHtml` and extracting from
  that if `bodyText` is null/empty. Match `https?://` URLs (bare links —
  the Gmail confirmation link is exactly this shape). Dedupe, preserve
  first-seen order, cap at a reasonable count (e.g. 20) so a body stuffed
  with tracking-pixel URLs doesn't produce a wall of links.
- Unit tests: a body with a single confirmation-style URL; a body with
  multiple links (dedup); a body with no links (empty array); a
  malformed/truncated body doesn't throw.

## 5. Inbox UI

- `app/(receipt-system)/receipts/inbox/page.tsx`: `listPendingIntake`
  already returns full rows — just needs the new fields passed through
  (should be automatic via `SELECT *`, confirm and pass to the client
  component).
- `components/receipts/inbox/inbox-row.tsx`:
  - Show `body_text` (truncated to a reasonable preview length in the list
    row, e.g. 200 chars) when present.
  - Detail/expanded view: full `body_text` in a `<pre>`/wrapped text block;
    an "View as HTML" toggle that renders `body_html` inside the sandboxed
    iframe per decision #3, only when `body_html` is present and the
    toggle is on (don't render by default).
  - Extracted-links list (from `extractLinks`) rendered as a small list of
    `<a target="_blank" rel="noopener noreferrer">` links, positioned
    prominently (above or beside the body) since finding the Gmail
    verification link fast is the actual point of this feature.
  - If `body_truncated`, show a small note ("body truncated at capture —
    very large message") so it doesn't look silently incomplete.

## 6. Tests

- `email-parse.test.ts`: cases from §4.
- `email-intake.test.ts`: `recordIntake` persists body_text/body_html/
  body_truncated correctly on both the zero-attachment and with-attachment
  paths; truncation cap enforced and flag set; existing tests for the
  no-attachment/invalid-attachment branches still pass unchanged.
- Full existing suite: zero regressions.

## 7. Verification & report (required)

Against live bindings:

1. Send (or simulate) a body-only email and one with both a body and an
   attachment to receipts@ (or however you can safely trigger the intake
   Worker) — confirm both land with body_text/body_html populated
   correctly in `/receipts/inbox`.
2. Confirm the HTML toggle renders inside the sandboxed iframe (inspect
   the DOM — sandbox attribute present, no script execution even if you
   test with a body containing an inline `<script>`).
3. Confirm extracted links render as clickable, `target="_blank"`,
   `rel="noopener noreferrer"`.
4. Confirm a deliberately oversized body triggers truncation + the flag,
   not a dropped/rejected row.
5. `npm test`, `tsc --noEmit`, `npm run build:cf` clean.

Report back: which migration number you used, test counts, and explicit
pass/fail per step above. Flag anything ambiguous rather than improvising
past it — in particular, if PostalMime's `parsed.html`/`parsed.text` shapes
differ from what this prompt assumes, report the actual shape. Do not
deploy — the architect verifies independently before deploy. Do NOT start
on Phase B (auto-promotion) — that's a separate prompt after this ships.
