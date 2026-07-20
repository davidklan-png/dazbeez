ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising, ESPECIALLY on §1 (the queue-integration question) —
that one genuinely needs your live read of the code before either of us can
finalize it.

# Email intake — auto-promote body-only receipts (Phase B of 2)

Prerequisite: Phase A (`WORKER-PROMPT-email-body-visibility-phaseA.md`)
shipped — `email_receipt_intake.body_text`/`body_html` exist and are
captured. This phase makes body-only receipts (no attachment) become real,
extractable receipt records automatically, for a specific trusted-sender
allowlist only.

## Background — why this is more than "render the body to a PDF"

David explicitly asked for this as a fully-automatic pipeline (his call,
made with the risk explained to him): no operator click required, unlike
every other capture path in this system, which all land in a queue for
manual triage/classification first. That changes the risk profile —
receipts@ is a public, unauthenticated address, so automatic promotion
without ANY gate would let a stranger who emails it create financial
records in David's books unattended. The compensating control (architect
decision, not optional, load-bearing — see §2) is a sender allowlist +
SPF/DKIM requirement: only pre-approved senders (David's own forwarding
Gmail address, initially) get auto-promoted; everyone else's body-only mail
behaves exactly as it does today (visible, `pending_triage`, needs a manual
Promote). Auto-promoted receipts still land in the SAME `needs_review`
queue and go through every existing compliance/classification/export gate
(category, payment_path, attendees, etc.) before they can be exported — the
allowlist changes whether the intake→receipt STEP is automatic, not whether
the receipt still needs normal human review before it's export-ready.

Rendering (turning an HTML/text body into something the existing
image/PDF-based MLX extraction pipeline can OCR) cannot happen inside the
Cloudflare Worker that receives the email — Workers have no headless
browser / HTML-to-PDF capability, and per the pattern already established
(every other "transform bytes" step — proof-copy JPEG generation, PDF
rasterization for MLX input — already lives in `scripts/receipts-consumer/
consumer.py` on the Mac, not the Worker; ADR 0001's "Mac-only" scope is
specifically about VLM model inference, but the SAME Mac-side-processing
convention is worth keeping for consistency and because Mac tooling already
exists there). So this is necessarily a TWO-PHASE async pipeline:

- **Phase 1 (synchronous, in the Worker, at email-arrival time):** for an
  allowlisted+authenticated body-only email, immediately create the
  `receipt_records` row via the SAME single insert path everything else
  uses (`createReceiptRecord` — email-intake.ts's own header comment is
  explicit: "Nothing in email_receipt_intake is a tax record. Only
  promoteIntake creates a receipt_records row... Do not add a second insert
  path into receipt_records." — respect that for this new function too).
  The RAW body (whichever of text/html is available, prefer html if
  present else text) is stored immediately as the receipt's TRUE original —
  this needs no rendering, it's a plain R2 put the Worker can do itself.
- **Phase 2 (asynchronous, on the Mac):** the Mac consumer picks up a "needs
  render" job, fetches the raw body, renders it to PDF/image (§3), and
  posts the result back to be stored as a SECOND, non-original file. Only
  once that lands does the receipt become eligible for the normal MLX
  extraction queue.

## §1 — YOU must investigate this before finalizing the wiring (do this first)

Read `lib/receipts/extraction-queue-db.ts`, `scripts/receipts-consumer/
consumer.py`'s job-fetching loop, and `app/api/receipts/[id]/proof/
route.ts` (the existing precedent for "Mac generates a derived file, POSTs
it back, gets stored as a `receipt_files` row" — model the render-result
callback on this, don't invent a parallel mechanism). Answer and report
back before writing the render-trigger wiring:

- Exactly when/how does a normal receipt (attachment or manual upload)
  become eligible for MLX extraction today — at `createReceiptRecord` time,
  or a separate explicit enqueue call? Where's that call?
- Can the existing extraction-queue state machine cleanly express "not
  eligible for extraction YET — needs a render first" (e.g. a new
  `extraction_state` value inserted before `'queued'`), or does it assume
  the file is already image/PDF-ready the moment a receipt is created? If
  the latter, what's the smallest change to make it support a "pending
  render" precondition without a bigger refactor?
- How does the Mac consumer currently authenticate a POST-back (the
  `x-receipts-processor-key` pattern from `/api/receipts/[id]/file/
  route.ts` — is there an equivalent write-side endpoint already, or does
  this need a new one modeled on the proof-copy route?

If the existing queue genuinely can't support a two-state (render → then
extract) job without a large refactor, STOP and report the shape of the
problem back to the architect rather than improvising a workaround.

## Decisions already made (do not revisit)

1. **Sender allowlist + SPF/DKIM gate for auto-promotion (non-negotiable
   safety net).** A new config value — simplest viable mechanism: a Worker
   secret/env var, e.g. `TRUSTED_INTAKE_SENDERS` (comma-separated email
   addresses, case-insensitive match against `from_address`). Auto-promote
   ONLY when `from_address` is on this list AND `spf_pass && dkim_pass`
   both true. Otherwise: record the intake row exactly as today
   (`pending_triage`, body visible per Phase A), no auto-promotion — falls
   back to manual Promote (which you're also extending to support
   body-only rows in §5, since `assertPromotable` today hard-requires
   `attachment_r2_key`). No UI for managing the allowlist in this pass —
   operator manages it via `wrangler secret put` / env var, same tier of
   effort as other operational config in this repo.
2. **Data model — preserve the ADR-0011 original/derivative distinction
   cleanly:**
   - `receipt_files`: TWO rows for an auto-promoted (or manually-promoted)
     body-only receipt. Row 1: `role="original"`, `is_original=true`,
     pointing at the RAW body bytes (whichever of html/text was captured,
     content_type `text/html` or `text/plain` accordingly) — this is what
     satisfies the Japanese electronic-bookkeeping preservation check
     (`lib/receipts/compliance.ts:158-174` — the "screenshot proxy" warning
     only fires when the `is_original=1` file's content_type starts with
     `image/`; text/html or text/plain never trips it, so DO NOT let the
     rendered derivative be the `is_original` row). Row 2: `role="processed"`
     (reuse the existing `ReceiptFileRole` value, `lib/receipts/types.ts:225`
     — no new role needed), `is_original=false`, pointing at the Mac-rendered
     PDF/PNG.
   - `receipt_records.original_r2_key` — ALWAYS points at the true original
     (the raw body here) — never repoint this at the rendered derivative.
     This preserves the existing system-wide invariant (everywhere else in
     the codebase, `original_r2_key` IS the compliance original) — do not
     break that invariant for this one source type.
   - New nullable column `receipt_records.extraction_r2_key` — set once the
     Mac render completes, points at the rendered derivative.
   - `app/api/receipts/[id]/file/route.ts` (the SINGLE canonical R2-read
     endpoint — used by both the human review UI via Clerk auth AND the Mac
     consumer via the `x-receipts-processor-key` header, per the comment at
     line ~10) gets one small branch: serve `extraction_r2_key ??
     original_r2_key`. This transparently feeds BOTH the MLX consumer and
     the human reviewer's image pane with the rendered derivative once it
     exists, with ZERO changes needed to `consumer.py`'s fetch logic.
   - New `SourceType` value `"email_body"` (`lib/receipts/types.ts:169-176`),
     added to `ELECTRONIC_SOURCE_TYPES` in `lib/receipts/compliance.ts:22-28`
     alongside `"email_attachment"` — distinguishes body-sourced receipts
     from attachment-sourced ones for audit/reporting, and keeps the same
     electronic-preservation compliance check active for this new path.
3. **Rendering: Mac-side, NO JavaScript execution engine, NO live network
   access during render.** This is a security requirement, not a
   preference — receipts@ is a public address, the body is fully
   attacker-controlled. Do NOT use a full headless-browser renderer
   (Puppeteer/Playwright/Cloudflare Browser Rendering) — those execute
   embedded `<script>` content, which is exactly the risk to avoid. Use a
   static HTML→PDF (or →PNG) renderer with no JS engine (e.g. WeasyPrint,
   already a natural fit since `consumer.py` is Python and already uses
   PIL/pymupdf) — chosen specifically BECAUSE it can't execute scripts.
   Regardless of library: (a) strip `<script>`, `<iframe>`, `<object>`,
   `<embed>` tags from the HTML before rendering, defense in depth even
   though the renderer shouldn't execute them; (b) neutralize remote
   resource loads (external `<img src>`, CSS `url(...)`, `<link
   rel=stylesheet>` pointing off-host) before rendering, or render with
   network access disabled entirely — an unmitigated renderer that fetches
   attacker-specified URLs during rendering is an SSRF vector (the render
   process could be made to hit internal-network addresses). If the body
   is plain text only (no html), render that directly (no HTML parsing
   risk at all in that case).
4. **Auto-promoted receipts still need normal review before export** — this
   is already true structurally (compliance/blockers/export gates don't
   care how a receipt was captured), just confirm you haven't accidentally
   pre-filled `payment_path`/`expense_category_code` to bypass those gates.
   `payment_path` defaults `UNKNOWN` exactly as email-intake already does
   for attachments (`buildPromoteReceiptInput` never sets it).

## 2. Migration

`ls db/receipts/*.sql` to confirm the next number. Additive:

```sql
ALTER TABLE receipt_records ADD COLUMN extraction_r2_key TEXT;
```

(Plus whatever `extraction_state` addition §1's investigation determines is
needed for the "pending render" precondition — confirm shape with the
architect if it's not a trivial additive value.)

## 3. Rendering step

New Mac-side capability (exact module placement up to you — likely
alongside `consumer.py`'s existing render helpers, e.g. `_rasterize_pdf`).
Input: raw body bytes + content type (html or text) fetched via the
existing `/file` endpoint (processor-key auth, per `route.ts` pattern).
Output: PDF or PNG bytes. Apply the sanitization/no-network constraints
from decision #3 before invoking the renderer.

## 4. Auto-promotion function (`lib/receipts/email-intake.ts`)

New function (name your own, e.g. `autoPromoteBodyIntake`) — NOT a second
insert path into `receipt_records`; it must call the same
`createReceiptRecord` used everywhere else. Triggered from the Worker's
`email()` handler when: zero valid attachments AND `from_address` matches
`TRUSTED_INTAKE_SENDERS` AND `spf_pass && dkim_pass`. Synchronously (Phase
1 above): create the receipt with `sourceType: "email_body"`, raw body as
`originalR2Key`/the `is_original` `receipt_files` row, `capturedBy:
from_address`, `status: "captured"`. Then hand off to whatever mechanism
§1's investigation determined for the async render trigger.

## 5. Manual-promote fallback for non-allowlisted body-only intake

Extend `assertPromotable`/`promoteIntake` (or add a body-only sibling
function that shares the core logic) so a human can still manually promote
a body-only intake row from `/receipts/inbox` when it wasn't auto-promoted
(unknown sender, failed SPF/DKIM, or the operator wants to promote one that
the allowlist skipped). Same render pipeline, just triggered by the
Promote click instead of automatically.

## 6. Tests

- Allowlist + SPF/DKIM gating logic: allowlisted+authenticated → auto-
  promotes; allowlisted but SPF/DKIM fails → does NOT auto-promote, stays
  `pending_triage`; non-allowlisted sender → does NOT auto-promote
  regardless of SPF/DKIM.
- `receipt_files` row shapes: `is_original` row is the raw body
  (content_type text/*, never image/*) — add a regression test asserting
  `compliance.ts`'s `electronic_transaction_missing_original` check does
  NOT fire for an email_body receipt once both files exist (mirrors the
  existing screenshot-proxy test if one exists, or write a fresh one).
  `processed` row is the rendered derivative, `is_original=false`.
  `original_r2_key` never repointed at the derivative;
  `extraction_r2_key` set only after render completes.
- `/file` route: serves `extraction_r2_key` when present, falls back to
  `original_r2_key` when null — both for processor and human-auth callers.
- Renderer sanitization: a body containing `<script>`/external resource
  references does not execute/fetch during render (whatever test harness
  fits your chosen renderer).
- Full existing suite: zero regressions, especially the existing email-
  intake and compliance tests.

## 7. Verification & report (required)

Against live bindings:

1. Report §1's findings and get them acknowledged (by the architect, via
   the operator relay) before proceeding if the queue needs a nontrivial
   change — this is the one item worth a checkpoint mid-implementation
   given the uncertainty.
2. Configure `TRUSTED_INTAKE_SENDERS` with a test address you control; send
   a body-only test email from it; confirm: receipt created immediately,
   raw body stored as `is_original` file, render job picked up, `processed`
   file + `extraction_r2_key` appear after the Mac consumer runs, receipt
   proceeds through normal MLX extraction, and it's visible in
   `/receipts/review` at `needs_review` same as any other capture.
3. Send a body-only test email from a NON-allowlisted address — confirm it
   stays `pending_triage` in the inbox, unchanged from today's behavior,
   and can still be manually promoted.
4. Confirm the compliance check does not flag `electronic_transaction_
   missing_original` for the auto-promoted receipt.
5. Confirm a deliberately malicious test body (inline `<script>`, external
   resource reference) renders safely — no script execution, no outbound
   fetch during render (check Mac-side network activity or renderer logs
   if feasible).
6. `npm test`, `tsc --noEmit`, `npm run build:cf` clean.

Report back: §1's answers, test counts, and explicit pass/fail per step
above. Flag anything ambiguous — in particular if the existing extraction-
queue state machine resists the two-phase render-then-extract shape, or if
your chosen renderer can't cleanly guarantee no-network/no-JS — rather than
shipping a weaker version silently. Do not deploy — the architect verifies
independently before deploy.
