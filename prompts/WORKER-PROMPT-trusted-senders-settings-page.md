ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Move TRUSTED_INTAKE_SENDERS from env var to a Settings page

Follow-up to ADR 0011 Phase B (email body auto-promotion,
`prompts/WORKER-PROMPT-email-body-auto-promotion-phaseB.md`, implemented
this session). Today the auto-promote allowlist is a
`TRUSTED_INTAKE_SENDERS` env var read once at module load in
`scripts/receipts-consumer/consumer.py` (line ~73-75) — operator has to
edit a Worker secret/local `.env` to change it. David wants this managed
from a Settings page in the app instead.

## Decisions already made (do not revisit)

1. **New dedicated table, not `receipt_settings`.** `receipt_settings`
   (`db/receipts/0014_compliance.sql:74-90`) is a single-row-per-scalar-key
   store — fine for one JSON blob, wrong shape for a list that needs
   individual add/remove + per-entry audit. Mirror the **Trusted devices**
   page instead (`app/(receipt-system)/receipts/settings/devices/page.tsx`,
   `lib/receipts/trusted-devices.ts`) — same naming pattern, same
   one-row-per-entry shape, closest existing analog in this codebase.
2. **Consumer reads D1 directly, no new HTTP endpoint.** The Mac consumer
   already reads D1 directly via `wrangler d1 execute --remote` for
   `pull_pending_rows`/`pull_auto_promote_candidates`
   (`consumer.py`'s `_d1_query()`, ~line 557-572) — this is a SEPARATE auth
   path from the `x-receipts-processor-key` HTTP calls (D1 reads use the
   operator's own `wrangler login` OAuth, not the processor key). Adding
   "read trusted senders" is one more `_d1_query()` call, same pattern —
   do NOT build a new API route + processor-key auth for this, it's
   unnecessary given the existing direct-D1-read precedent.
3. **Single source of truth — remove the env var entirely**, don't keep it
   as a fallback. The whole point of this change is that the Settings page
   becomes authoritative; a stale env var that silently still works would
   undermine that.
4. **Store emails lowercase, normalized at write time.** `isAutoPromoteEligible`
   (`lib/receipts/email-parse.ts:224-236`) already lowercases `fromAddress`
   before comparing — keep the stored list lowercase so the comparison
   stays a simple set-membership check, no case-folding needed at read time.

## 1. Migration

`ls db/receipts/*.sql` to confirm the next number (0028 is taken by
`0028_receipt_render_pipeline.sql`). New file:

```sql
CREATE TABLE trusted_intake_senders (
  email TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`email` as the primary key gives natural dedup (no separate unique index
needed). No seed data — table starts empty; David adds his forwarding
address via the UI after deploy.

## 2. `lib/receipts/trusted-senders.ts` (new file, mirrors `trusted-devices.ts`)

```ts
export interface TrustedIntakeSender {
  email: string;
  added_by: string;
  created_at: string;
}
export async function listTrustedSenders(): Promise<TrustedIntakeSender[]>
export async function addTrustedSender(email: string, actor: string): Promise<void>
export async function removeTrustedSender(email: string, actor: string): Promise<void>
```

- Normalize (trim + lowercase) the email in `addTrustedSender` before
  insert. Basic format validation (contains `@`, no whitespace) — reject
  obviously malformed input with a clear error rather than silently
  storing garbage; this doesn't need to be a full RFC 5322 validator.
- `addTrustedSender` should be an idempotent upsert (`INSERT ... ON
  CONFLICT(email) DO NOTHING` or similar) — adding an already-present
  address shouldn't error.
- Audit entries on both add and remove (`createAuditEntry`, action e.g.
  `trusted_sender.added` / `trusted_sender.removed`), consistent with the
  compliance-settings and attendee-directory precedents.

## 3. API route `app/api/receipts/settings/trusted-senders/route.ts`

Mirror `app/api/receipts/settings/compliance/route.ts`'s auth
(`requireReceiptsActor` — Clerk session, not processor-key; this route is
for the human-facing settings page only):
- `GET` → `listTrustedSenders()`.
- `POST` (body `{ email }`) → `addTrustedSender(email, actor)`.
- `DELETE` (body or query `{ email }`) → `removeTrustedSender(email, actor)`.

## 4. Settings page `app/(receipt-system)/receipts/settings/trusted-senders/page.tsx`

Mirror the devices page's structure (`settings/devices/page.tsx`): header +
description ("Emails on this list auto-file body-only receipts into the
books with no manual review — see ADR 0011 Phase B. Only add addresses you
control and are actively forwarding from."), a list of current entries
(email, added_by, created_at, remove button), and an add form (single
email input + submit). New client component
`components/receipts/trusted-senders-list.tsx` (mirror
`components/receipts/device-list.tsx`'s client-side add/remove pattern —
optimistic update + router.refresh(), or whatever pattern that component
already uses).

Link it from the settings index
(`app/(receipt-system)/receipts/settings/page.tsx:35-50` has the exact
pattern for the devices `<li>` — add a sibling `<li>` for "Trusted intake
senders" → `/receipts/settings/trusted-senders`, description e.g. "Email
addresses that can auto-file receipts with no manual review.").

**Explicit warning copy on the page itself** (not just the settings index
description) — this list controls the ONE safety gate for a
zero-human-review auto-promotion path (ADR 0011 Phase B), so the page
should make that plain: something like "Auto-promotion has no manual
review step. Only add email addresses you control." Don't undersell this
as a routine settings toggle.

## 5. Consumer (`scripts/receipts-consumer/consumer.py`)

- Remove the `TRUSTED_INTAKE_SENDERS` module-level env-var constant
  (~line 73-75) and its `os.environ.get(...)` read entirely.
- New function, called once at the top of `process_auto_promote` (not
  cached across the process's lifetime beyond that — each launchd
  invocation is short-lived, no need for in-memory TTL logic):
  ```python
  def fetch_trusted_senders() -> list[str]:
      """Read the auto-promote allowlist from D1 (Settings page is
      authoritative — see trusted_intake_senders table). Uses the same
      _d1_query() path as pull_pending_rows/pull_auto_promote_candidates."""
  ```
  `SELECT email FROM trusted_intake_senders` via `_d1_query`, return the
  list (already lowercase from storage).
- `is_auto_promote_eligible` (~line 753-766) currently closes over the
  module-level `TRUSTED_INTAKE_SENDERS` constant — change its signature to
  accept the senders list as a parameter instead, and thread it through
  from `pull_auto_promote_candidates`/`process_auto_promote` (call
  `fetch_trusted_senders()` once per run, pass the result down). Keep it a
  pure function otherwise.
- If the table is empty (no senders configured yet), auto-promote should
  simply promote nothing — not error. Print a clear one-line notice in
  `process_auto_promote`'s dry-run/summary output when the fetched list is
  empty, so the operator isn't confused about why nothing auto-promoted.

## 6. Tests

- `trusted-senders.ts`: add/list/remove round-trip; add is idempotent on a
  duplicate; add rejects obviously malformed input; email normalized to
  lowercase on write.
- `is_auto_promote_eligible` Python tests (if a test file already covers
  it — check for `test_consumer.py` or similar; if none exists for this
  function yet, add one): now takes senders as a parameter; empty list →
  nothing eligible; case-insensitive match against a lowercase-stored list.
- Full existing suite: zero regressions.

## 7. Verification & report (required)

Against live bindings:

1. Apply the new migration; confirm the table exists empty.
2. Add a test address via the Settings page UI; confirm it round-trips
   (shows in the list, persists on refresh) and an audit entry was
   recorded.
3. Remove it; confirm it's gone and a removal audit entry exists.
4. Run `consumer.py --auto-promote` (dry-run) with the table empty —
   confirm it reports zero candidates with a clear "no trusted senders
   configured" notice, not a silent no-op or an error.
5. Add a real test address, send a body-only test email from it, confirm
   `--auto-promote --write` picks it up (same as the Phase B live check,
   now sourced from the DB instead of the env var).
6. `npm test`, `tsc --noEmit`, `npm run build:cf` clean; consumer Python
   tests (if any) pass.

Report back: migration number used, test counts, and explicit pass/fail
per step above. Do not deploy — the architect verifies independently
before deploy.
