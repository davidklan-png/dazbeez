ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Capture destination address on email intake rows

Small follow-up to ADR 0011 (email receipt intake). Design of record:
`docs/adr/0011-email-receipt-intake.md`, "Scope change (2026-07-19...)"
section — read it for the full context before starting.

## Background (do not re-litigate)

`receipts@dazbeez.com` and `receipt@dazbeez.com` both route to the
`dazbeez-receipts-email-intake` worker (`receipt@` exists purely as
misspelling-tolerance for `receipts@` — same intent, same expected
senders). A third address, `billing@dazbeez.com`, was briefly wired to the
same worker and has since been REMOVED from Email Routing by the operator —
do not re-add it or design around it still existing.

Right now nothing records which of the two addresses a given email arrived
on. `message.to` is read once in `workers/receipts-email-intake/src/index.ts`
purely for a size-ceiling log line; `recordIntake()` has no `toAddress`
field; `email_receipt_intake` has no `to_address` column;
`/receipts/inbox` never surfaces it (it's technically inside
`raw_headers_json`'s "to" entry via `pickRawHeadersSubset`, but nothing
reads it back out for display). With only two same-purpose addresses this
is low-urgency (a nice-to-have audit detail — "which spelling did the
sender use" — not a noise/triage problem), which is why it wasn't built in
the original pass. Still worth doing: it's cheap, additive, and closes a
gap the architect flagged.

## Decisions already made (do not revisit)

1. **New column, not a rename/repurpose of anything existing.**
   `email_receipt_intake.to_address TEXT` — nullable (older rows created
   before this migration won't have it; do not backfill, do not make it
   NOT NULL).
2. **Populate it in the worker from `message.to`** (the Cloudflare
   `ForwardableEmailMessage.to` field — the same value already read for
   the existing log line), not by re-parsing MIME `To:` headers. If a
   message somehow has no `message.to` (shouldn't happen given Email
   Routing invoked the worker because of a matching rule, but be
   defensive), store `null`, don't throw.
3. **Surface it as a small inline label in `/receipts/inbox`**, not a
   filter/dropdown — two values doesn't justify a filter UI. Simple text
   near the from-address, e.g. "→ receipt@dazbeez.com" in a muted style, so
   a human triaging can see it at a glance without extra clicks.
4. **Do not touch `promoteIntake`/`rejectIntake`/`createReceiptRecord`.**
   `to_address` is intake-side metadata only — it does not flow into
   `receipt_records` (which has no concept of "which alias captured this,"
   and shouldn't gain one just for this). It stays in `email_receipt_intake`
   as historical/audit context, full stop.

## 0. Live investigation FIRST (read-only, include in report)

- Confirm next free migration number: `ls db/receipts/*.sql | sort | tail
  -3` (expect last is `0024_email_intake.sql`; yours is the next number).
- Read `db/receipts/0024_email_intake.sql`, `lib/receipts/email-intake.ts`,
  `lib/receipts/email-parse.ts`, `workers/receipts-email-intake/src/index.ts`,
  `app/(receipt-system)/receipts/inbox/page.tsx`, and
  `components/receipts/inbox/inbox-row.tsx` in full before editing any of
  them — this is a small change across several files, don't guess at
  current shapes.
- Confirm `EmailReceiptIntake` type location (`lib/receipts/types.ts`) and
  its exact current field list before adding `to_address`.

## 1. Migration

New file `db/receipts/00NN_email_intake_to_address.sql` (NN per §0):

```sql
-- 00NN_email_intake_to_address.sql
--
-- Adds to_address to email_receipt_intake so a human triaging /receipts/inbox
-- can see which alias (receipts@ or receipt@dazbeez.com) captured a given
-- email. Nullable — older rows predate this column. Intake-side metadata
-- only; does NOT flow into receipt_records on promote (ADR 0011 follow-up,
-- 2026-07-19 scope-change note).
ALTER TABLE email_receipt_intake ADD COLUMN to_address TEXT;
```

## 2. Types + `recordIntake`

- `lib/receipts/types.ts`: add `to_address: string | null` to
  `EmailReceiptIntake`.
- `lib/receipts/email-intake.ts`: `RecordIntakeInput` gains
  `toAddress: string | null`. Thread it through the INSERT in
  `recordIntake()` (new column, new bind param) for every row variant
  (zero-attachment row, valid-attachment row, invalid-attachment row — all
  three currently exist in that function, don't miss one).
- Existing `tests/receipts/email-intake.test.ts` will need its fake-D1
  insert assertions/row builders updated for the new column — update them
  minimally (add the field, don't restructure the test file's existing
  fake-D1 harness).

## 3. Worker: pass `message.to` through

`workers/receipts-email-intake/src/index.ts`, in `processMessage`: add
`toAddress: message.to ?? null` to the `recordIntake(...)` call's input
object. That's the only worker change — no new investigation needed here,
`message.to` is already read on the line above (currently only used in the
size-ceiling warn log).

## 4. Inbox UI

`components/receipts/inbox/inbox-row.tsx`: render `to_address` when
present, near `from_address` — muted/secondary text, something like:

```tsx
{intake.to_address && (
  <p className="truncate text-xs text-gray-400">→ {intake.to_address}</p>
)}
```

Placement: directly under the existing from/subject block, before the
SPF/DKIM badges row — keep it unobtrusive, this is context, not a primary
field. Don't add a filter control (per decision #3).

## 5. Tests

- `email-intake` tests: confirm `to_address` round-trips through
  `recordIntake` for all three row-insert branches (zero-attachment,
  valid, invalid).
- If there's an existing pure-function test file for the worker glue
  (`tests/receipts/email-parse.test.ts` or similar), no change needed
  there unless you added a new pure helper — prefer not to; this is
  simple enough to not need one.
- Run the full existing suite; ZERO regressions accepted.

## 6. Verification & report (required)

1. Root: `npx tsc --noEmit` clean.
2. Root: `npm test` — report before/after counts, confirm zero
   regressions.
3. Root: `npm run build:cf` clean.
4. Worker: `cd workers/receipts-email-intake && npx tsc --noEmit` clean.
5. Worker: `npx wrangler deploy --dry-run` — confirm it still builds and
   report the bundle size (compare to the previous 140.20 KiB / gzip 33.82
   KiB baseline; a small increase is expected and fine, a large one is
   worth flagging).
6. Do NOT apply the new migration and do NOT deploy the worker — same
   posture as every other prompt in this repo, the architect/operator
   applies migrations and deploys after review.

Report back: §0 findings, files touched, test counts before/after, and
explicit pass/fail per verification step.
