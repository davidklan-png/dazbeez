ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Email receipt intake — receipts@dazbeez.com

**STATUS (2026-07-19): §1/§2/§4/§5/§7 built and verified — tsc clean, 590
tests passing (25 new), `build:cf` clean. §3 (email handler placement) and
§6 (cleanup cron) were correctly stopped-and-reported per this prompt's
instruction; both are now resolved in ADR 0011's decision record. Follow-up
implementation prompt: `prompts/WORKER-PROMPT-receipts-email-intake-worker.md`.
Migration 0024 is written but NOT yet applied (Mac action, live D1 creds
required). This file is kept as-is below for history — do not re-run it.**

Design of record: `docs/adr/0011-email-receipt-intake.md`. Read it first —
this prompt is the implementation checklist, the ADR is the "why."

## Decisions already made with the operator (do not revisit)

1. **Ingestion mechanism is Cloudflare Email Routing**, not a third-party
   inbound-email API (Postmark/SendGrid/Mailgun). The Worker gets a native
   `email()` handler. No new vendor, no new webhook secret.
2. **Accept mail from any sender.** Do not build allow-list enforcement at
   the mail layer. SPF/DKIM verdicts are captured and shown to the human
   triaging, not used to auto-reject.
3. **Unauthenticated mail never writes to `receipt_records` directly.** It
   lands in a new `email_receipt_intake` table at `status='pending_triage'`.
   Only an explicit human "Promote" action creates a real `receipt_records`
   row, via the *existing* `createReceiptRecord()` — do not write a second
   insert path into `receipt_records`.
4. **v1 is attachments only.** No email-body parsing/rendering. An email
   with no attachment is still recorded (so it's visible in the inbox) but
   has nothing to promote.
5. **Reuse the existing pipeline after promotion.** A promoted receipt is
   inserted exactly like mobile/desktop capture — `status: "captured"`,
   `source: "email"`, `sourceType: "email_attachment"`, `paymentPath` /
   `expenseType` default to `"UNKNOWN"` (already-supported values, see
   `db/receipts/0001_init.sql` CHECK constraints). It then flows through
   the existing extraction queue → Mac MLX → review queue unchanged. Do
   not build a parallel extraction or review path for email receipts.

## 0. Live investigation FIRST (read-only, include output in report)

- `SELECT MAX(CAST(SUBSTR(name,1,4) AS INTEGER)) FROM (SELECT name FROM sqlite_master WHERE type='table');` — not useful directly; instead just confirm the next free migration number: `ls db/receipts/*.sql | tail -5` (expect the last one to be `0023_business_trip_receipts.sql`; your new migration is the next number).
- Confirm current `wrangler.jsonc` has no existing `email` binding/config (there shouldn't be one — this is new).
- Confirm Cloudflare Email Routing is not already configured for the zone (dashboard check, or `wrangler` if it exposes this — report what you find; if you can't check from this environment, note that and flag it for the Mac-side operator step).
- Read `lib/receipts/upload-policy.ts` in full (already read by the architect — confirm `ALLOWED_RECEIPT_MIME_TYPES`, `ALLOWED_RECEIPT_EXTENSIONS`, `MAX_RECEIPT_FILE_BYTES` are exported and reusable as-is).
- Read `lib/receipts/db.ts` `createReceiptRecord()` (~line 49) and confirm the `CreateReceiptInput` shape in `lib/receipts/types.ts` (~line 553) accepts `source`, `sourceType`, `status`, `originalR2Key`, `originalSha256`, `originalContentType`, `originalSizeBytes`, `capturedBy` — this prompt assumes it does; report if it doesn't and stop.

## 1. Database: `email_receipt_intake` table

New migration `db/receipts/0024_email_intake.sql` (adjust number per §0):

```sql
CREATE TABLE IF NOT EXISTS email_receipt_intake (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  from_address TEXT NOT NULL,
  subject TEXT,
  spf_pass INTEGER NOT NULL DEFAULT 0,
  dkim_pass INTEGER NOT NULL DEFAULT 0,
  attachment_r2_key TEXT,
  attachment_sha256 TEXT,
  attachment_content_type TEXT,
  attachment_size_bytes INTEGER,
  attachment_filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending_triage'
    CHECK (status IN ('pending_triage','promoted','rejected')),
  reject_reason TEXT,
  promoted_receipt_id TEXT REFERENCES receipt_records(id),
  raw_headers_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_intake_status
  ON email_receipt_intake(status, received_at);
```

This table carries **no** `retention_until` / `legal_hold` columns and is
NOT subject to the compliance/retention posture `receipt_records` has —
that is intentional per ADR 0011, do not add them.

## 2. R2 storage for intake attachments

Reuse `RECEIPTS_BUCKET` (do not create a new bucket). Key pattern for
intake objects, kept distinguishable from promoted receipts:
`receipts-intake/{YYYY}/{MM}/{intake_id}/{uuid}-{filename}`. On promotion,
either move/copy the object to the standard
`receipts/{YYYY}/{MM}/{id}/{uuid}-{filename}` key pattern the rest of the
system expects (check `lib/receipts/storage.ts` for the exact helper to
reuse — do not hand-roll a second key-building function) or, if a copy is
avoided for cost/simplicity, confirm with the architect before pointing
`receipt_records.original_r2_key` at an `receipts-intake/...` key — that
would leak the intake key pattern into the main table's invariants and
needs an explicit decision, not an assumption.

## 3. Worker `email()` handler

- Add an `email` export alongside the existing Next.js/OpenNext `fetch`
  handler. Check `.open-next/worker.js` generation and `open-next.config.ts`
  for how to attach a custom `email()` handler in this OpenNext setup —
  this may require a small wrapper/shim rather than editing generated
  output directly. If OpenNext doesn't cleanly support a custom `email()`
  export, stop and report; do not fork the build to force it in.
- Handler logic:
  1. Hard pre-parse size ceiling (10 MiB) on the raw message — reject
     before allocating/parsing anything larger. This is independent of and
     tighter-than the existing 5 MiB `MAX_RECEIPT_FILE_BYTES` receipt
     limit, which is checked per-attachment afterward.
  2. Parse MIME, extract attachments. Ignore body content in v1 (do not
     store rendered HTML/text bodies anywhere).
  3. Read SPF/DKIM verdicts Cloudflare Email Routing attaches to the
     message (confirm exact header/property names against current
     Cloudflare docs for the `EmailMessage` type — do not guess the shape).
  4. For each attachment (v1: handle the first valid attachment per email;
     if an email has multiple attachments, create one intake row per
     attachment — confirm this fan-out is acceptable, it's implied but not
     explicit in the ADR, flag if ambiguous):
     - Validate against `ALLOWED_RECEIPT_MIME_TYPES` /
       `ALLOWED_RECEIPT_EXTENSIONS` / `MAX_RECEIPT_FILE_BYTES` from
       `upload-policy.ts`.
     - If valid: write to R2 (intake key pattern above), insert
       `email_receipt_intake` row with `status='pending_triage'`, sha256,
       content type, size.
     - If invalid (wrong type / too large / unreadable): still insert an
       `email_receipt_intake` row (so it's visible, not silently dropped)
       with `attachment_r2_key = NULL` and a `reject_reason` explaining why
       — do not set `status='rejected'` automatically for size/type
       failures either; leave it `pending_triage` with the reason visible
       so a human sees *why* it can't be promoted, per ADR "flagged and
       cannot be promoted until resolved."
  5. Email with zero attachments: insert one `email_receipt_intake` row
     with all attachment_* fields NULL, `reject_reason = 'no attachment'`.

## 4. Promotion / rejection: `lib/receipts/email-intake.ts` (new)

```ts
export async function promoteIntake(intakeId: string, actor: string): Promise<string /* receiptId */>;
export async function rejectIntake(intakeId: string, reason: string, actor: string): Promise<void>;
export async function listPendingIntake(): Promise<EmailReceiptIntake[]>;
```

- `promoteIntake`: load the intake row, refuse if `attachment_r2_key` is
  NULL (nothing to promote — surface this as a client-side disabled state
  too, don't rely only on the server check) or `status !== 'pending_triage'`.
  Call `createReceiptRecord()` with `source: "email"`,
  `sourceType: "email_attachment"`, `status: "captured"`,
  `capturedBy: intake.from_address`, `originalR2Key`/`originalSha256`/
  `originalContentType`/`originalSizeBytes` copied from the intake row,
  `paymentPath: undefined` / `expenseType: undefined` (let the existing
  `"UNKNOWN"` defaults in `createReceiptRecord` apply — do not pass
  literal `"UNKNOWN"` if the function already defaults it, match existing
  call-site convention, check `app/api/receipts/upload/route.ts` for how
  it calls `createReceiptRecord` today). Update the intake row to
  `status='promoted'`, `promoted_receipt_id=<new id>`. This must run inside
  a transaction/batch consistent with how `createReceiptRecord` already
  handles its own inserts — do not leave the intake row unpromoted if the
  receipt insert fails, or vice versa.
- `rejectIntake`: requires non-empty `reason`. Sets `status='rejected'`,
  `reject_reason=reason`. Does not delete the R2 object immediately (see
  §6 cleanup).
- Audit log both actions via `lib/receipts/audit.ts` (`createAuditEntry`),
  action names `email_intake.promoted` / `email_intake.rejected`, with
  `newValueJson` including the SPF/DKIM verdicts from the intake row so the
  audit trail answers "why did we trust this" even though the sender
  itself was unauthenticated.

## 5. Review screen: `/receipts/inbox`

New route group entry: `app/(receipt-system)/receipts/inbox/page.tsx`.
Clerk-gated exactly like every other `/receipts/*` page (reuse
`requireReceiptsActor` / `assertReceiptsPageAccess` — do not invent a
separate auth check).

- List `email_receipt_intake` rows at `status='pending_triage'`, most
  recent first. Show: sender, subject, received time, SPF/DKIM pass/fail
  badges, attachment thumbnail/filename (or the `reject_reason` if
  attachment is missing/invalid), and Promote / Reject buttons.
- Promote button disabled when `attachment_r2_key IS NULL`.
- Reject requires a reason (small text input, not optional).
- New API routes: `POST /api/receipts/inbox/[id]/promote`,
  `POST /api/receipts/inbox/[id]/reject`. Same auth pattern as the rest of
  `/api/receipts/*`.
- Do not touch `/receipts/review` or its lock/month-scoping logic — this
  is a separate, simpler screen by design (ADR 0011 rationale).

## 6. Scheduled cleanup

Delete R2 objects (and optionally the row, or just null the R2 key while
keeping the row for audit history — prefer keeping the row, nulling
`attachment_r2_key`, confirm with architect if unsure) for
`email_receipt_intake` rows where `status IN ('rejected')` OR
(`status='pending_triage'` AND `received_at` older than 30 days), on
whatever existing scheduled/cron mechanism this repo already uses for
other cleanup jobs (check for an existing cron trigger in `wrangler.jsonc`
or a scripts/ cleanup pattern before adding a new mechanism).

## 7. Tests

- `email-intake` unit tests (fake D1, pattern: existing fakes like
  `MonthLockD1` / `receipt-locks` tests): promote happy path creates a
  `receipt_records` row with correct `source`/`sourceType`/`status`;
  promote refuses when `attachment_r2_key` is NULL; promote refuses when
  status isn't `pending_triage`; reject requires a reason; reject doesn't
  touch `receipt_records`.
- MIME/attachment validation tests: oversized attachment flagged not
  silently dropped; disallowed mime type flagged; zero-attachment email
  recorded with `reject_reason='no attachment'`; multi-attachment fan-out
  (per §3.4 resolution).
- Run the full existing suite (`npm test` — tsx --test, not vitest per
  prior verification notes); ZERO regressions accepted.

## 8. Verification & report (required)

Against live bindings (`npm run cf:dev` or the standard live workflow):

1. Send a test email with a valid PDF/image attachment to
   `receipts@dazbeez.com` (requires Email Routing actually configured on
   the Mac/operator side first — coordinate, this may be a live-mail test
   the architect or operator has to trigger, not something you can fully
   self-serve from a sandboxed session; report what you could vs. couldn't
   verify end-to-end).
2. Confirm a `email_receipt_intake` row appears at `pending_triage` with
   correct sender/SPF/DKIM/attachment metadata.
3. `/receipts/inbox` shows it; Promote creates a `receipt_records` row
   with `source='email'`, `sourceType='email_attachment'`,
   `status='captured'`, `extraction_state='captured'`, and it shows up in
   the normal review queue exactly like a mobile capture once the Mac
   consumer (or a manual "Process queue" trigger) processes it.
4. Reject path: reason required, row moves to `rejected`, no
   `receipt_records` row created.
5. Oversized/wrong-type attachment: row visible in inbox with reason,
   Promote disabled.
6. `npm run build:cf` clean.

Report back: §0 findings (especially the OpenNext `email()` handler
feasibility check and Cloudflare Email Routing config status), files
touched, test counts before/after, explicit pass/fail per verification
step, and anything you had to stop and flag per the decisions in §0–§6
above rather than improvise. Do not deploy; the architect verifies
independently before deploy.
