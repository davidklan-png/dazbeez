ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# receipts-email-intake worker — §3 + §6 of ADR 0011

This is the follow-up to the previous email-receipt-intake WORKER REPORT,
which correctly stopped at §3 (email handler placement) and §6 (cleanup
cron) and asked the architect to decide. Design of record:
`docs/adr/0011-email-receipt-intake.md` — read the full "Decision record
(2026-07-19)" section before starting, it resolves both blockers.
`lib/receipts/email-intake.ts` (already built, tested, do not redesign it)
is the producer/consumer logic this worker calls into.

## Decisions already made with the operator/architect (do not revisit)

1. **Standalone Cloudflare Worker, not the main `dazbeez` OpenNext worker.**
   Confirmed independently (not just per the prior report): `.open-next`
   only exports `fetch`, and `@opennextjs/cloudflare`'s override surface has
   no `email`/`scheduled` hook. New worker:
   `workers/receipts-email-intake/`, mirroring the existing
   `workers/email-reply-capture/` worker's structure exactly — own
   `wrangler.jsonc`, own `package.json`, own `tsconfig.json`, `src/index.ts`.
2. **Bindings:** `RECEIPTS_DB` (D1, `dazbeez-receipts`,
   `database_id: 8dffd78f-b9aa-490d-822d-4f413e52aeba` — copy from the main
   `wrangler.jsonc`) and `RECEIPTS_BUCKET` (R2, `dazbeez-receipts`). No
   other bindings — this worker does not need `RECEIPTS_ARCHIVE_BUCKET`,
   `CRM_DB`, or Clerk config.
3. **MIME parsing: reuse `postal-mime`** (already a vetted dependency of
   `email-reply-capture`, same version constraint `^2.4.3`). Do not
   evaluate alternative MIME libraries.
4. **Cleanup cron lives in this same worker** (`[triggers].crons` +
   `scheduled()` handler), not the main app. 30-day stale window
   (`INTAKE_STALE_DAYS` from `lib/receipts/email-intake.ts`) is confirmed,
   do not renegotiate.
5. **Do not touch the main `dazbeez` worker, `wrangler.jsonc`, or
   `open-next.config.ts`.** This is fully additive and isolated.
6. **Do not apply migration 0024, wire Cloudflare Email Routing, or
   deploy.** Migration application is the architect/operator's action on
   the Mac (live D1 credentials aren't available in a sandboxed session).
   Email Routing DNS/dashboard config is an out-of-band control-plane step,
   same posture as the Queues HTTP consumer in ADR 0001.

## 0. Live investigation FIRST (read-only except where noted, include in report)

1. Read `workers/email-reply-capture/src/index.ts`,
   `workers/email-reply-capture/wrangler.jsonc`,
   `workers/email-reply-capture/package.json`,
   `workers/email-reply-capture/tsconfig.json` in full — this is your
   structural template.
2. **Import portability check (this is the real technical risk here, do
   not skip it).** `lib/receipts/email-intake.ts`'s `recordIntake()` and
   its transitive deps (`classifyAttachment`, `generateIntakeR2Key`,
   `sanitizeFilenameForR2` from `lib/receipts/storage.ts`, constants from
   `lib/receipts/upload-policy.ts`, `nowIso`/`newUuid`/`stringifyJson` from
   `lib/receipts/db-utils.ts`, types from `lib/receipts/types.ts`) are
   currently imported with the Next.js `@/*` path alias (see
   `tsconfig.json` `paths`). `email-reply-capture`'s precedent
   (`lib/crm-reply-monitor.ts`) avoided this entirely by being written with
   only relative imports from day one, and its worker's `tsconfig.json`
   `include`s the shared file by relative path with NO alias mapping.
   `lib/receipts/email-intake.ts` was NOT written that way. Before writing
   any worker code:
   - Check whether `lib/receipts/storage.ts`, `upload-policy.ts`,
     `db-utils.ts`, `types.ts` themselves contain any further `@/`-aliased
     imports (not just check `email-intake.ts`).
   - Try the fast path first: add `"paths": { "@/*": ["../../*"] }` to a
     new `workers/receipts-email-intake/tsconfig.json` (relative to that
     directory, up to repo root) and attempt `npx wrangler deploy --dry-run
     --outdir=/tmp/dryrun` (or `wrangler dev` and hit it) to see if
     esbuild/wrangler's bundler actually resolves the alias. Report exactly
     what happens — this is genuinely uncertain, don't assume either way.
   - If the alias does NOT resolve: convert `email-intake.ts`'s own import
     lines (and only those, in that one file — do not touch how
     `storage.ts`/`upload-policy.ts`/`db-utils.ts`/`types.ts` are imported
     by the rest of the Next app) to relative paths (`./storage`,
     `./upload-policy`, `./db-utils`, `./types`), and repeat the check one
     level deeper for whichever of those files also has `@/`-aliased
     imports in their own transitive chain. After any such edit, run the
     FULL existing Next app test suite + `tsc --noEmit` + `npm run
     build:cf` to confirm zero regressions from the import-style change —
     this touches a file the Next app also depends on.
   - If neither resolves cleanly, stop and report rather than forking
     `email-intake.ts` into two copies.
3. **SPF/DKIM header availability — verify empirically, do not assume.**
   Per the architect's research (ADR 0011 decision record), Cloudflare's
   "Email Routing → Worker" delivery path may NOT reliably stamp an
   `Authentication-Results` header (known issue, `cloudflare/workerd#6740`
   at investigation time — may have changed, check current
   `developers.cloudflare.com/email-routing` docs for the current message
   object shape). Confirm what headers/properties are actually present on
   a live test `ForwardableEmailMessage` once you can send one (§8). Do not
   guess a header name and ship it unverified.
4. Confirm current `wrangler.jsonc` (main app) `d1_databases`/`r2_buckets`
   entries for `RECEIPTS_DB`/`RECEIPTS_BUCKET` (database_id/bucket_name) —
   copy the exact values into the new worker's `wrangler.jsonc`, don't
   retype from memory.

## 1. `workers/receipts-email-intake/` scaffold

Mirror `email-reply-capture`'s files:

- `package.json` — `name: "dazbeez-receipts-email-intake"`, `postal-mime`
  dependency, same `deploy`/`dev` scripts, same devDependency versions
  (`@cloudflare/workers-types`, `typescript`, `wrangler`) unless a version
  check shows those are stale — if so, match whatever the main repo or
  `email-reply-capture` currently pins, don't introduce a third version.
- `tsconfig.json` — per §0.2 findings (alias or relative includes).
- `wrangler.jsonc`:
  ```jsonc
  {
    "$schema": "../../node_modules/wrangler/config-schema.json",
    "name": "dazbeez-receipts-email-intake",
    "main": "src/index.ts",
    "compatibility_date": "2025-08-01",
    "compatibility_flags": ["nodejs_compat"],
    "d1_databases": [
      {
        "binding": "RECEIPTS_DB",
        "database_name": "dazbeez-receipts",
        "database_id": "8dffd78f-b9aa-490d-822d-4f413e52aeba"
      }
    ],
    "r2_buckets": [
      { "binding": "RECEIPTS_BUCKET", "bucket_name": "dazbeez-receipts" }
    ],
    "triggers": {
      "crons": ["0 3 * * *"]
    }
  }
  ```
  (Daily at 03:00 UTC for cleanup — adjust only if you find an established
  cron-time convention elsewhere in the repo to match; otherwise this is
  fine, it's not user-facing.)

## 2. `src/index.ts` — `email()` handler

Follow `email-reply-capture`'s shape (`readRaw`, `PostalMime.parse`,
`waitUntil`), but this worker does NOT forward mail anywhere (no
`FORWARD_TO` — receipts intake keeps the message, it isn't a reply-capture
passthrough). Logic:

1. Read raw bytes (reuse the same `readRaw(message.raw, message.rawSize)`
   pattern).
2. Enforce `INTAKE_MAX_MESSAGE_BYTES` (10 MiB, exported from
   `lib/receipts/email-intake.ts`) BEFORE calling `PostalMime.parse` — if
   `message.rawSize` (or the read byte length) exceeds it, log and return
   without processing further. Do not call `message.setReject(...)` unless
   you confirm from current Cloudflare docs that's the correct API for
   this case — if unsure, just drop (do not process) and log; message
   rejection semantics are not specified in the ADR and guessing wrong
   here could bounce legitimate mail.
3. Parse with `postal-mime`. Extract:
   - `fromAddress` (`parsed.from?.address`)
   - `subject` (`parsed.subject`)
   - `receivedAt` (`parsed.date` → ISO, fallback to now)
   - `attachments`: postal-mime's parsed attachment array — map to
     `ParsedEmailAttachment { filename, contentType, sizeBytes, data }`
     (check postal-mime's actual attachment shape — field names in
     `email-reply-capture`'s usage only cover text/html, not attachments;
     confirm the attachment content field, likely `content` as
     `ArrayBuffer`/`Uint8Array`, from postal-mime's own types).
   - `spfPass`/`dkimPass`: per §0.3 findings — real verdicts if available,
     otherwise `false` with a code comment explaining why (not a silent
     guess).
   - `rawHeadersJson`: `JSON.stringify` of whatever header set is actually
     useful/available (don't dump everything if it's huge; a reasonable
     subset — from, to, subject, date, message-id, whatever
     authentication-related headers exist).
4. Call `recordIntake(env.RECEIPTS_DB, env.RECEIPTS_BUCKET, input)` inside
   `ctx.waitUntil(...)`, matching the `captureAndLog` pattern in the
   precedent worker. Log outcome (ids created) on success, log-and-swallow
   on failure (per the existing pattern of failing safe rather than
   throwing and bouncing mail — confirm this is still right for receipts;
   if `email()` throwing causes Cloudflare to bounce the message to the
   sender, silently swallowing might mean a receipt is lost with no trace
   beyond worker logs — flag this trade-off in your report, don't just
   copy the pattern unexamined).

## 3. `scheduled()` handler — cleanup cron

New export in the same `src/index.ts` (or a separate `src/cleanup.ts`
imported by `index.ts` — your call, keep it simple):

- Query `email_receipt_intake` for rows where `status = 'rejected'` OR
  (`status = 'pending_triage'` AND `received_at` older than
  `INTAKE_STALE_DAYS` (30) days) AND `attachment_r2_key IS NOT NULL`.
- For each: delete the R2 object (`env.RECEIPTS_BUCKET.delete(key)`), then
  `UPDATE email_receipt_intake SET attachment_r2_key = NULL WHERE id = ?`.
  Keep the row (audit history) — per ADR 0011, only the R2 object is
  disposable, not the row.
- Do NOT auto-transition stale `pending_triage` rows to `rejected` — the
  ADR says cleanup deletes the R2 object after 30 days, it does not say
  auto-reject the row. If a stale `pending_triage` row's attachment is
  deleted, it becomes functionally unpromotable (no `attachment_r2_key`)
  automatically, which is the correct end state — don't add a redundant
  status flip on top.
- Batch reasonably (e.g. `LIMIT 200` per run, cron runs daily so backlog
  drains over a few days if ever large) rather than unbounded — this
  matches the caution already shown elsewhere in the receipts module
  (`RECEIPT_VIEW_LIMIT` pattern) about unbounded D1 queries.

## 4. Tests

- Unit-test the pure pieces you can (header/attachment extraction logic,
  size-ceiling check, cron row-selection query logic) with a fake
  D1/R2 — check `tests/receipts/` for existing fake-binding patterns
  (`MonthLockD1` etc.) and mirror the style. `workers/email-reply-capture`
  may not have its own test suite — check, and if it doesn't, don't block
  yourself on matching a precedent that isn't there; use the main repo's
  fake-D1 test patterns instead since that's what `email-intake.test.ts`
  already established.
- Do NOT modify `tests/receipts/email-intake.test.ts` unless you find an
  actual bug in `recordIntake`/`classifyAttachment` while wiring this up —
  it's already written and passing (25 tests, confirmed independently by
  the architect). If §0.2's import-path fix touches files that test
  depends on, re-run it and confirm it still passes.

## 5. Verification & report (required)

1. `cd workers/receipts-email-intake && npm install && npx tsc --noEmit`
   clean.
2. `npx wrangler dev` (or the dry-run approach from §0.2) — confirm it
   builds/bundles without unresolved-import errors. This is the practical
   proof of the §0.2 investigation, not just a doc read.
3. If you have any way to send a real test email to a Cloudflare Email
   Routing test destination bound to this worker in a dev/staging
   capacity, do so and report exact header/attachment shapes observed
   (§0.3). If you cannot (no live Email Routing wiring exists yet — that's
   an operator step this prompt explicitly excludes), report clearly that
   this remains unverified against live mail and is the next gate before
   the architect/operator wires DNS.
4. From the ROOT repo (not the worker subdirectory): `npx tsc --noEmit`
   and `npm test` — confirm zero regressions in the main app from any
   §0.2 import-path changes.
5. Do NOT run `wrangler deploy` for this worker, and do NOT touch the main
   `dazbeez` worker's deploy. Report readiness; the architect/operator
   deploys after review, same as every other prompt in this repo.

Report back: §0 findings in full (especially the import-portability
resolution and the SPF/DKIM header reality), files created, test
results, and an explicit list of what's still needed before this can go
live (migration 0024 applied, Email Routing DNS/dashboard wiring, first
deploy of the new worker).
