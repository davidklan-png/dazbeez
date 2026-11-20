# AMEX line/trip write safety — PR219 integrated, release gates pending


## Integration completion — 2026-11-21 JST

Merged `origin/master` **dbe3c4f7dc6f28a88c2ec5e675a5ecd42b930926**
(PR219) normally; merge commit **048112f**. The previous implementation head was
`b01039200bb60b669b9b5e90bc9001f204b350e2`. No push, production write,
migration, deployment, restart, queue lease or email was performed.

The prior phase below is historical. PR219 is now merged here; integration is
implemented. **This is still a draft, not release acceptance:** build/runtime
and mounted-browser gates could not run successfully under this sandbox.
Parent independent review and the production verification remain outstanding.

### Completed coupling

- Reconcile POST requires a safe `expectedReceipts` map for exactly the loaded
  selected/suggested and previous receipt contexts. The matching D1 batch
  asserts receipt identity/revision/deleted state, target lifecycle and finalized
  claims before any line/receipt/audit mutation. Server code never calls the
  receipt HTTP PATCH. Existing classification/adoption/demotion behavior stays
  atomic. Receipt and admitted sibling-line tokens are selected in that batch;
  a later writer cannot be mistaken for its acknowledgement.
- Reconcile keeps loaded receipt tokens and accepts only validated own action
  acknowledgements. Single, bulk and consolidated decisions share these tokens;
  sibling line tokens are admitted before they can be acknowledged. Line edits
  and trip actions also return exact affected receipt tokens. Missing, malformed,
  unsafe, regressed or wrong-set acknowledgements halt; no automatic retry.
- Shared SaveQueue retains PR219's required `initialRevision`, fixed-URL
  PATCH/DELETE idle barrier, receipt conflict message/halt and draft/navigation
  behavior. The AMEX URL/method action overload shares its serialized lane.
  Inline category editing uses that queue for each target identity, including
  PR219's receipt branch, optimistic draft retention and explicit reload.
- 0048 adds reverse receipt invalidation for line rosters, trip business context,
  pointer/link membership and OLD/NEW parents; receipt-only overlay members also
  invalidate their observing trips/member lines. Counter-only updates do not
  reverse-trigger. Reads assert snapshots without consuming revisions.
- Real SQLite fixtures apply **0001–0048 with foreign keys**. Both recursion
  modes, stale non-deleted candidates, extraction/merge/publication invalidation,
  exact acknowledgements, previous receipt admission, consolidated/bulk outcomes,
  sealed financial rows and Delete-versus-confirm races in both admission orders
  pass. R7 deletion UX and tentative-detach implementation were not added.
- All **47 shipped migrations 0001–0047 match origin/master byte-for-byte**.
  No dependencies, endpoints, middleware, default cf:dev script or production
  configuration changed. No pre-existing untracked files were present.

### Integration gate commands and results

All commands use this worktree and Node **v22.23.2** via `fnm exec --using 22`.
The final gate rerun covers the committed implementation; a documentation-only
results commit may follow it.

1. `fnm exec --using 22 npm test` — **blocked**, exit 1 before test collection:
   tsx cannot create its IPC socket (`listen EPERM .../tsx-501/*.pipe`).
2. IPC-free full suite:
   `fnm exec --using 22 node --require /tmp/amex-tsx-runner.cjs --import tsx --experimental-test-module-mocks --test 'tests/**/*.test.ts'`
   — **2,041 collected, 2,040 pass, 0 fail, 1 existing skip**
   (`export-revision-flow.test.ts`, rev-2 create/finalize integration).
   The temporary runner only replaces nested CLI invocations of tsx with
   `node --import tsx`; no product, database or transport mocks are added.
   Without that child-launch workaround the same suite had 11 environment-only
   CLI failures. The temporary file is reproducible as:

   ```js
   const cp = require('node:child_process');
   const original = cp.spawnSync;
   cp.spawnSync = function(command, args, options) {
     if (Array.isArray(args) && /[/\\]tsx[/\\]dist[/\\]cli\.mjs$/.test(args[0] || '')) {
       args = ['--import', 'tsx', ...args.slice(1)];
     }
     return original.call(this, command, args, options);
   };
   require('node:module').syncBuiltinESMExports();
   ```

3. Targeted command:

   ```sh
   fnm exec --using 22 node --import tsx --experimental-test-module-mocks --test \
     tests/receipts/amex-receipt-coupling.test.ts \
     tests/receipts/amex-write-persistence.test.ts \
     tests/receipts/receipt-revision.test.ts tests/receipts/save-queue.test.ts \
     tests/receipts/category-cell.test.ts tests/receipts/amex-line-patch.test.ts \
     tests/receipts/attendee-atomic.test.ts tests/receipts/reconciliation.test.ts \
     tests/receipts/reconciliation-signoff.test.ts tests/receipts/business-trips.test.ts \
     tests/receipts/amex-import-contract.test.ts tests/receipts/amex-replace-retire.test.ts \
     tests/receipts/review-navigation.test.ts
   ```

   **261 collected, 261 pass, 0 fail, 0 skip**. Full suite also covers seal
   publication/upgrade/route races, duplicate, cross-month and manifest suites.
   The seal-route injected ambiguous-batch fixture now targets the publication
   batch, allowing the newly added snapshot-assertion reads to finish first.
4. Changed TS/TSX/MJS file list from `git diff --name-only origin/master` plus
   `git ls-files --others --exclude-standard`, passed as individual arguments to
   `fnm exec --using 22 node node_modules/eslint/bin/eslint.js` — **pass, zero
   errors/warnings**. `git diff --check` — **pass**.
5. `fnm exec --using 22 npx next typegen` — **blocked**, exit 1: OpenNext config
   initialization cannot listen on 127.0.0.1 (`EPERM`).
   `fnm exec --using 22 npx tsc --noEmit` — **pass** using available generated
   types; fresh Next type generation remains unverified.
6. `fnm exec --using 22 npm run build:cf` — **blocked**, exit 1: Next/OpenNext's
   local binding bridge cannot open a loopback listener (`EPERM`). No successful
   final Worker artifact was emitted.
7. `fnm exec --using 22 npx wrangler dev --local --port 8795 --inspector-port 9255 --var CLERK_SECRET_KEY:sk_test_local_fixture_only`
   — **blocked**, exit 1: `.open-next/worker.js` absent after the failed build.
   Wrangler's default preferences log path was also write-denied. No boot or
   HTTP result is claimed. The key is synthetic; no remote binding was used.
8. `fnm exec --using 22 node scripts/check-amex-write-fixture.mjs` — bundle/CSS
   generation succeeds, but local Chrome/CDP times out before any scenario
   result, exit 1. **0 verified mounted runs** at this checkpoint. The fixture
   now includes 12 scenarios for each 375/1024 viewport (24 intended runs),
   adding real-editor loaded candidate, consolidated own acknowledgements,
   stale candidate and malformed receipt-ack cases. These still need an
   unrestricted local browser run; no screenshots or signed-in UI state were
   observed here.

Remaining release gates: parent independent frozen-head review; ordinary npm
launcher, fresh typegen, build:cf, local boot/routing/auth and mounted 375/1024
fixtures in a sandbox that permits them. After separate authorization and
migration/deploy, run the deployment smoke and inspect signed-in live receipt,
line/trip values, badges, blocker lists and counts per AGENTS Step 4. No claim
of live-state correctness or release readiness is made by this report.

### Exact changed files versus merged origin/master

```text
app/(receipt-system)/receipts/reconcile/page.tsx
app/api/receipts/amex/lines/[id]/route.ts
app/api/receipts/reconcile/route.ts
app/api/receipts/trips/[id]/candidates/route.ts
app/api/receipts/trips/[id]/members/route.ts
app/api/receipts/trips/[id]/route.ts
components/receipts/export/inline-category-cell.tsx
components/receipts/reconcile/business-trip-strip.tsx
components/receipts/reconcile/reconcile-screen.tsx
components/receipts/trips/trip-detail-screen.tsx
db/receipts/0048_amex_write_revision.sql
docs/audits/2026-11-19-amex-write-safety-implementation.md
lib/receipts/amex-write.ts
lib/receipts/api/amex-line-patch.ts
lib/receipts/business-trips.ts
lib/receipts/category-cell.ts
lib/receipts/db.ts
lib/receipts/month-closing.ts
lib/receipts/save-queue.ts
lib/receipts/types.ts
scripts/check-amex-write-fixture.mjs
tests/receipts/amex-receipt-coupling.test.ts
tests/receipts/amex-write-persistence.test.ts
tests/receipts/attendee-atomic.test.ts
tests/receipts/blockers.test.ts
tests/receipts/category-cell.test.ts
tests/receipts/fixture/amex-entry.tsx
tests/receipts/helpers/amex-sqlite.ts
tests/receipts/manifest-csv.test.ts
tests/receipts/month-closing.test.ts
tests/receipts/reconciliation-signoff.test.ts
tests/receipts/reconciliation.test.ts
tests/receipts/save-queue.test.ts
tests/receipts/seal-route-races.test.ts
tests/receipts/statement-window.test.ts
tests/receipts/tier1-10-cross-month-guard.test.ts
```

## Prior independent phase (historical)

Base: `be216d5812aea2b6b98389ffa483c593c4353ed6` (merged PR218), branch
`polly/receipts-amex-write-safety-20261119`, dedicated worktree of the same name.
The adopted contract and investigation are the parent's
`.polly/contracts/receipts-amex-write-safety-20261119.md` and
`.polly/reports/amex-write-safety-20261119.md`.

**Draft only. This is not full acceptance or merge/deployment readiness.**
PR219 remains OPEN (last observed head
`36bd46981e45ff560e644f08c6a53094e61f1e43`). No219 commit was stacked,
cherry-picked, or copied; migration0047 and shipped0001–0046 are unchanged.

## Implemented independently

- 0048 seeds FK-cascaded line revision state without updating financial lines,
  including existing sealed rows. Trip context gets its own safe-integer revision.
  Named, always-empty SQL assertion constraints make stale/missing admission fail
  inside the D1 transaction. Direct SQL invalidation covers all line columns,
  attendee OLD/NEW parents, receipt business/roster/files, pointer/link trip unions,
  retained rejected links, directory, artifact, reconciliation, and export context.
  Counter-only updates do not trigger reverse business invalidation. Both trigger
  recursion modes are exercised. Observing trips also invalidate when a member's
  receipt/context changes, preventing metadata acknowledgement from blessing an
  unseen changed member.
- Existing line PATCH atomically admits, changes sparse fields/roster, consumes
  its token, audits, and selects the exact acknowledgement. Missing and stale
  identities refuse even empty bodies/rosters. Existing reconciliation POST
  admits its line before any receipt consequence, checks missing/deleted/archived
  targets, and commits matching/classification/adoption/demotion and both audits
  together. **Its receipt-revision admission is still blocked below.**
- Trip PATCH/attach/detach use one batch with context/member-token/ownership
  admission, exact whole-trip member sets, actual changed/unchanged counts, audit,
  and in-batch acknowledgements. A sealed member rolls everything back. Receipt
  overlays remain financial-row-free. Detection checks current decisions and
  ownership and audits in its transaction; candidate-only widening remains.
- Actual readers carry revisions; multi-read Reconcile/export loaders verify
  their loaded tokens rather than attaching a fresh token to old fields. Trip
  detail reads are one batch. Export rows carry presentation-only line tokens;
  accountant manifest bytes do not change when revisions change.
- SaveQueue adds opt-in revision validation, concrete endpoint/method actions,
  full-drain observation, and verified aggregate-token consumption. Receipt
  behavior on this base remains intact. Reconcile has per-line sparse lanes,
  raw Japanese drafts, IME deferral, awaited selection/product links/signoff,
  visible refusal/unknown recovery, and no automatic retry. Whole-trip actions
  drain and pause the line lanes, then resume late edits using their own verified
  aggregate acknowledgements. Export's line category branch and all trip editors
  send loaded tokens and retain drafts on failure. Matched category rows still
  route to receipts.

## Exact verification

All commands ran in this dedicated worktree. Node22 is `v22.23.2`.

- `fnm exec --using 22 npm test` — files `tests/**/*.test.ts`; **2,006 collected
  cases, 2,005 pass, zero fail, one pre-existing skip** (the rev-2
  create/finalize integration case in `export-revision-flow.test.ts`). These are
  collected cases, not test-function or assertion counts. Includes all focused
  line/trip/category/queue/navigation/import/retirement/duplicate/cross-month and
  seal migration/upgrade/publication/route-race suites.
- `fnm exec --using 22 npx tsx --experimental-test-module-mocks --test
  tests/receipts/amex-write-persistence.test.ts
  tests/receipts/amex-replace-retire.test.ts
  tests/receipts/attendee-atomic.test.ts` — 43 collected cases,43 pass at that
  checkpoint; the subsequent full run also covers the added upgrade/coherence
  regressions. Every new persistence fixture applies0001–0046+0048 with FKs;
  actual production writers/routes execute against real SQLite.
- `fnm exec --using 22 node scripts/check-amex-write-fixture.mjs` — actual mounted
  ReconcileScreen plus actual SaveQueue/navigation, using recorded router and
  deferred fetch only: **nine scenarios at each of375px/1024px,18 scenario runs**.
  Reason blur/selection, late typing, IME, pending timer before signoff,
  roster/category/keyboard busy-slot interleaving, whole-trip boundary/late edits,
  conflict, removal, malformed200, and lost acknowledgement all pass. These are
  browser scenarios, not Node collected cases. Chrome is local and DNS is blocked.
  Screenshots inspected at
  `/var/folders/8n/h9_kn57j7b3dclfmks45lb3w0000gn/T/amex-mounted-yL0Osm/`.
  The existing two-pane Reconcile layout requires horizontal scrolling at375px;
  this repair does not redesign that layout. Synthetic fixtures are not signed-in
  production verification.
- `{ git diff --name-only -z -- '*.ts' '*.tsx' '*.mjs'; git ls-files --others
  --exclude-standard -z -- '*.ts' '*.tsx' '*.mjs'; } | xargs -0
  ./node_modules/.bin/eslint` — all changed/new TS/TSX/MJS files, no errors/warnings.
- `fnm exec --using 22 npx next typegen` and
  `fnm exec --using 22 npx tsc --noEmit` — pass, including the browser fixture.
- `fnm exec --using 22 npm run build:cf` — pass, Worker emitted.
- `git diff --check` — pass. No changes to package manifests, lockfile, middleware,
  production configuration, or existing migrations. Worktree-local dependencies
  are an APFS copy of existing installed dependencies; no dependency was added.

### Local runtime gate and its limit

`fnm exec --using 22 npm run cf:dev -- --port 8795` was attempted and **failed**
before boot: OpenNext's environment loader tried to authenticate the existing
`AI.remote=true` binding and got400. No login, remote binding call, real data test,
queue leasing, migration, or deployment followed.

The installed Wrangler help documents `--local` as disabling remote bindings.
The local-only fallback was:

```sh
fnm exec --using 22 npx wrangler dev --local --port 8795 --inspector-port 9255 --var CLERK_SECRET_KEY:sk_test_local_fixture_only
```

The key is an intentionally synthetic fixture value, not an account credential.
All D1/R2/Queue bindings reported **local**, AI unsupported locally. On the final
built Worker, `GET /` returned200, and unauthenticated `PATCH
/api/receipts/amex/lines/fixture`, `POST /api/receipts/reconcile`, `PATCH
/api/receipts/trips/fixture`, and `POST /api/receipts/trips/fixture/members`
returned Clerk's expected404 protection. The local server was then stopped.
This establishes boot/routing/auth gating only, not real-data functionality.
The default `cf:dev` script/configuration was deliberately not changed.

## Blocked integration/release checklist

- [ ] Parent supplies PR219's merged master state; integrate updated master by
  ordinary merge/rebase in this worktree/PR. Never merge219 or edit its worktree.
- [ ] Reuse219's actual receipt revision for loaded selected/suggested candidates
  and previous affected receipt contexts. Admit receipt snapshots in the same
  matching transaction, including current lifecycle/deleted/claim/seal policy.
  Existing line tokens do not protect an unlinked candidate's business edits.
- [ ] Select and validate exact affected receipt acknowledgements in that batch;
  propagate own acknowledged tokens across single/bulk/consolidated decisions.
  Integrate shared SaveQueue and receipt category branch deliberately, preserving
  receipt drafts, conflict halt, and navigation semantics from219.
- [ ] Integrate reverse receipt invalidation for line-attendee/trip context with
  0047 unchanged; exclude counter-only reverse triggers and prove finite recursion.
- [ ] Apply/test full0001–0048 chain, both receipt and line CAS suites, stale
  non-deleted candidates, extraction/merge/publication invalidation, and
  Delete-versus-confirm both orders. R7 reason/Delete UX remains separate.
- [ ] Rerun combined full/targeted/browser/lint/type/build/runtime gates and parent
  independent frozen-diff review before any merge-readiness claim.
- [ ] A separately authorized migration/deploy, deployment smoke and signed-in
  live375/1024 state inspection remain outstanding. No such action was authorized
  or performed here; no production cleanup or email was sent.
