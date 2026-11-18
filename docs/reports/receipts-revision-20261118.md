# Receipt aggregate revision V1 — implementation and verification

Contract: `.polly/contracts/receipts-revision-20261118.md`, workflow V1 and reliability B3/R3 (reports dated 2026-11-17). Initial baseline was `8691c7c95a888703dd92700e721ce5210e64d5f8`. Integrated base is **`7210b4d68f97411ba56b895ddcb9fd5559ce1b05`**, including merged PR217. Branch: `polly/receipts-revision-20261118`. PR218 is excluded; no capture UI or shared registry changes.

## Admission and invalidation

Migration **0047** adds a nonnegative safe-integer receipt `revision`. Every receipt-column UPDATE invalidates it, including timestamp-only duplicate touches and same-millisecond/same-value writes. Related attendee, matched AMEX line, receipt-file and export-item insert/update/delete triggers invalidate affected receipt parents, including both OLD and NEW owners. Hard deletion removes the token entirely. Revision-only updates neither change timestamps nor enter the existing financial/build seal change sets. Shipped migrations 0001–0046 are unchanged.

`updateReceiptRecord` and soft Delete insert a transient admission row first. Its trigger aborts the whole D1 batch for a missing/deleted/mismatched receipt; successful admission consumes the token and deletes its transient row. Fields, membership assignment/override, roster, revisions and success audits commit or roll back together. The final SELECT in that same batch returns the committed revision. It is never read later from mutable state. An admitted empty PATCH also consumes a token but emits no fabricated field-change audit. One accepted operation may advance the revision more than once because child mutations also invalidate it; clients exchange the exact acknowledgement rather than assuming +1.

Public PATCH/Delete require `expectedRevision` (400 `receipt_revision_required`); stale admission returns 409 `receipt_revision_conflict`. Existing lifecycle/seal refusals remain distinct. Internal extraction calls do not require a consumer/browser token: the helper admits the version it read, and triggers cover the other direct SQL writers. Lost batch acknowledgements and response failures remain unknown outcomes.

## Writer and caller inventory

| Writer/boundary | Coverage |
| --- | --- |
| `db.ts`: create, review update, soft/hard deletion, standalone roster helper | Creation seeds revision 0; public updates/Delete have transactional admission; receipt/roster triggers invalidate all direct writes. `createAttendees` has no runtime callers; public roster replacement uses the admitted update batch. |
| `db.ts`: reconciliation link/unlink/status/merchant/payment-path changes and AMEX replacement retirement | Receipt UPDATE trigger plus AMEX line OLD/NEW receipt triggers. |
| `capture.ts`: original key and enqueue-failure updates | Receipt trigger; no capture UI changes. `mobile-upload.ts` is a read-only idempotency lookup module, not a second insert path. |
| `duplicate-merge.ts`, `duplicate-purge.ts` | Receipt, roster, file and line invalidation; deletion removes token. Existing duplicate admission/fingerprints unchanged. |
| `export-publication.ts`, export-item writes/deletion | Receipt status and export-item invalidation; published bytes/seal authority unchanged. |
| `membership.ts` | Every direct membership UPDATE invalidates; automatic assignment and public override share the admitted review batch. |
| `extraction-queue-db.ts`, `extraction-failure.ts`, `render-recovery.ts` | Every direct receipt UPDATE invalidates, including metadata-only transitions. |
| `/[id]/enqueue`, `/[id]/render` | Direct receipt UPDATEs covered; processor auth and middleware exemptions unchanged. |
| `/[id]/extract` (three `updateReceiptRecord` calls) | Browser revision not required by processor API; helper revision admission and database invalidation apply. |
| Maintenance SQL in `repair-lifecycle-drift`, `migrate-membership-to-calendar-month`, `reprocess-extraction`, `fix-2016-date-anomaly`, manifest backfill and sealed-export deletion scripts | Same database triggers; none of these scripts was executed against live data. |
| FormPane autosave / Mark reviewed | SaveQueue sends latest acknowledged token at execution time, including coalesced/IME-held requests. |
| FormPane membership override / Delete | Flush edits first, share acknowledgement validation and conflict/unknown halt, disable competing actions, and refuse navigation while dedicated action runs. Delete surfaces errors and collects exported correction reason. |
| Inline receipt category cell, including matched-line receipt branch | Uses revision-bearing row/route props and SaveQueue acknowledgement/conflict handling. The AMEX line branch remains V2. Fixed the existing null-versus-empty render loop exposed by mounting an uncategorized row. |
| GET / server receipt pages / search and reconcile projections / bundle rows | GET and full-row readers include revision; projected receipt column lists include it; bundle rows carry `receiptRevision`, category routes carry it. Missing seed disables inline editing. Editor fixtures seed it. |

Compliance checks are derived diagnostics, recomputed after the committed PATCH and surfaced as warnings on failure; they do not change the receipt/roster token. A later writer after COMMIT cannot lend its token to the acknowledgement. Settings/attendee-directory metadata do not rewrite stored receipt names. AMEX line aggregate CAS and the separately planned complete tentative-link Delete workflow remain outside V1.

## Client and PR217 integration

Conflicts and missing/deleted receipts retain fields, roster and category choice, halt pending/future sends and save/advance, and explain explicit reload/review. Props refresh never adopts a new token into an existing editor; conflicted form state remains local. Browser reload/close has an unsaved-state guard; the explicit reload action confirms draft discard. Transport, malformed/unsafe/regressed acknowledgement and 5xx outcomes still halt without retry.

All PR217 `lockedRef` checks remain. Conflict halt takes priority over the clean locked-form navigation shortcut, and sealed-banner links use the navigation guard, so a seal refresh cannot silently discard an already-conflicted draft. Read-only fields/footer and correction draft behavior remain intact. No unmerged branch was stacked or cherry-picked.

## Green gates

Runtime: Node **22.23.2**. Commands run from the isolated worktree, using its lockfile-installed dependencies. No new dependency or lockfile change.

- `fnm exec --using 22 npm test`: **1970 collected cases; 1969 pass, 0 fail, 1 existing gated skip**, across `tests/**/*.test.ts` (155 test files). The skip is the opt-in local-D1 `export-revision-flow.test.ts`; actual full-chain SQLite correction/publication/route-race tests pass, including prior-revision preservation.
- Focused command below: **232 collected cases; 232 pass, 0 fail/skip**. The revision-only seal matrix is 48 combinations inside one collected case, not 48 additional cases. New regression tests execute actual writers/routes through real SQLite with the complete migration chain, foreign keys, and recursive triggers enabled. Coverage includes competing clients, same-ms writes, roster-only edits, extraction races, stale Delete, zero-row admission, empty-save policy, audit rollback, unknown commit response and exact committed acknowledgement after a later writer.
- Relevant ESLint: every changed TS/TSX/CJS file, **0 errors/warnings** (exact command in local gate log).
- `fnm exec --using 22 npm run cf-typegen`, then `fnm exec --using 22 npx tsc --noEmit`: pass. Generated binding drift was inspected and omitted because bindings did not change.
- `fnm exec --using 22 npm run build:cf`: pass after PR217 integration and final product changes.
- `fnm exec --using 22 npm run dev -- -p 4598`: boots; local `/` 200, unauthenticated receipt API 404 from Clerk protection.
- `fnm exec --using 22 npm run cf:dev -- --port 8895`: boots with local bindings; `/` 200, protected receipt API 404, processor `/extract` without credentials 401. A first preview without the local Clerk key returned 500; the keyed local check passed. No processor secret was copied into the preview. This proves routing/auth only, not real-data behavior.
- Synthetic browser command below: Chrome, real FormPane/SaveQueue/InlineCategoryCell, two tabs each at **375/1024**, 900ms response delay and synthetic Japanese composition events. Checks draft/roster retention, conflict stopping requests, refresh/reload-cancel, read-only seal refresh, guarded sealed-banner navigation, inline choice retention and newest-token serialization. Screenshots and actual field values inspected. The fixture uses a private ephemeral HTTP server, not live API mutations.
- `git diff --check`: pass. Existing shipped migration files and capture UI unchanged. CLI test subprocess resolution now uses installed `tsx/cli`, allowing its existing 11 collected cases to run in a worktree.

```sh
fnm exec --using 22 npx tsx --experimental-test-module-mocks --test \
  tests/receipts/receipt-revision.test.ts \
  tests/receipts/save-queue.test.ts \
  tests/receipts/review-navigation.test.ts \
  tests/receipts/category-cell.test.ts \
  tests/receipts/seal-boundary-migration.test.ts \
  tests/receipts/seal-boundary-upgrade.test.ts \
  tests/receipts/seal-publication-persistence.test.ts \
  tests/receipts/seal-route-races.test.ts \
  tests/receipts/duplicate-merge-trigger.test.ts \
  tests/receipts/duplicate-merge-service.test.ts \
  tests/receipts/duplicate-purge.test.ts \
  tests/receipts/soft-delete-carveout.test.ts \
  tests/receipts/receipt-locks.test.ts \
  tests/receipts/sealed-review-component.test.ts

# Existing external playwright-core; it is not added to package dependencies.
NODE_PATH=/Users/dklan/.npm/_npx/e058441c325e062a/node_modules \
  fnm exec --using 22 node tests/receipts/fixture/revision-browser.cjs
```

Browser evidence: `/tmp/receipt-revision-browser-reproducible.log`, with artifact directory printed there (screenshots and `results.json`). Other local logs: `/tmp/receipt-revision-exact-full.log`, `-exact-lint.log`, `-exact-build.log`; focused results at `/tmp/receipt-revision-integrated-focused.log`. The branch head and PR URL are recorded in the PR/final handoff to avoid a self-referential report hash.

## Rollout limits

Apply additive migration 0047 before releasing the new browser/API code. Older already-open clients lacking a token are refused and need an explicit reload. No force save or automatic merge is provided. This is receipt aggregate protection, not AMEX line V2 or application-wide CAS. Revisions conservatively invalidate metadata-only writes too, so a processor transition can require reload even when no accounting field changed.

No production migration, live receipt write, email, cleanup, consumer restart, deploy or merge was performed. No native OS IME/device test, signed-in production edit, or real D1/R2 functional check is claimed; browser composition/transport checks are synthetic, SQLite persistence checks use real local SQLite, and local Workers preview is only boot/routing/auth.
