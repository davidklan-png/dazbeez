# PR Notes — Export Module Remediation (2026-07-08 audit, branch `feat/export-remediation-2026-07`)

Paste-ready description for the worker to use when opening the PR. Captures
every commit on the branch and the exact Mac smoke-test sequence required
before merge. Do not edit the smoke-test list — it is the architect's
merge gate (F4 + A8).

## Branch commit list (11 commits ahead of `origin/master`)

| Commit     | Activity | Summary |
|------------|----------|---------|
| `087f6f5`  | audit prompt | docs(audit): export module architecture review prompt |
| `830d14c`  | A1 | feat(receipts/export): A1 single validation authority |
| `b479964`  | A2 | feat(receipts/export): A2 revision metadata propagation |
| `af9ae6d`  | A3 | feat(receipts/db): A3 migration 0017 export integrity |
| `34e1d2c`  | A4 | feat(receipts/export): A4 statement-month scope redesign |
| `c32d10c`  | A5 lifecycle/lock | feat(receipts): A5 split lock model + finalize lifecycle |
| `092e5d2`  | A5 CSV | feat(receipts/export): A5 CSV hardening + compliance columns |
| `ca1eda9`  | A6 | feat(receipts/export): A6 perf + honest UI |
| `2ebe8ae`  | A7 | feat(receipts/export): A7 multi-month finalize warnings |
| `fbd0332`  | A8 | docs(receipts): A8 architecture + ADRs 0002–0005 |
| `ab16754`  | F1–F3 | fix(receipts/month-lock): reopen month while draft revision exists |

## Paste-ready PR description

---

### Summary

Remediates the receipts export module per the 2026-07-08 architecture review
(activities A1–A8) plus the F1–F3 follow-up fix to the split lock model.

- **A1 — Single validation authority.** Both finalize paths now call
  `validateMonthReadyForExport(month)`. The inline AMEX-only loop in
  `POST /api/receipts/export/month` is deleted. The compliance engine now
  gates finalize: open `blocker` checks always block; open `warning` checks
  block when `receipt_settings.export_block_on_warnings = true`. The
  previously-documented setting is no longer a no-op.
- **A2 — Revision metadata propagation.** README + manifest now thread
  `export_revision`, `supersedes_export_id`, `correction_reason` from the
  loaded export row. Revision 2+ no longer ships claiming "Revision 1
  (initial)".
- **A3 — Migration 0017.** Adds `idx_exports_month_revision`,
  `idx_exports_one_draft` (one draft per month partial index), and the
  `receipt_export_items` audit-trail table. **Mac must apply this to live
  D1 before deploy.**
- **A4 — Export scope = statement month.** A monthly bundle now contains
  one row per AMEX statement line of month M (missing-receipt and
  no-receipt lines included with reasons), plus one row per CASH/DIGITAL
  receipt with `transaction_date` in M. `payment_path='UNKNOWN'` is a
  finalize blocker. Bundle assembly lives in one place
  (`buildExportBundle`); preview and ship are bit-identical.
- **A5 — Lifecycle + split lock + CSV hardening.** Finalize promotes
  bundle receipts to `status='exported'` with `exported_month=M`.
  `assertTransactionMonthEditable` gates CASH/DIGITAL edits by
  transaction month (AMEX stays governed by reconciliation-sealed).
  CSV now ships UTF-8 BOM + CRLF with formula-injection guard
  (`= + - @`). Six compliance columns added; new `-summary.csv` per
  bundle.
- **A6 — Performance + honest UI.** Batched attendee query collapses
  ~200 N+1 queries to 1 at 4 open months. `listAllReceiptsInMonth`
  pages with a hard cap (10 000) that raises instead of truncating.
  Export page shows real bundle bytes (not `rows*135`), drops the
  fabricated `cardLast4: "3091"`, removes dead `attendeesLogged: 0`,
  and uses `buildExportBundle` directly so preview matches ship.
- **A7 — 3–4 concurrent open months.** Cross-month match integrity
  blocker: a receipt matched to lines in two statement months blocks
  finalize on both. Out-of-order finalize is allowed and surfaces a
  non-blocking `warnings: string[]` for each earlier open month.
- **A8 — Tests + docs.** `docs/architecture.md` export section added;
  ADRs 0002–0005 cover the four architectural decisions (statement-month
  scope, compliance gate, split lock model, multi-open-month assumption).
- **F1–F3 — Correction-flow deadlock fix.** The A5 lock predicate
  deadlocked the correction flow: finalized rows are permanent, so the
  `?correction=true` revision draft existed but the month stayed locked.
  New `isMonthLockedForEdits(db, month)` returns true iff finalized
  exists AND no draft exists for the month — opening a revision
  reopens the month; finalizing the revision re-locks it. The
  in-process `finalizedMemo` Set is removed (it survives across
  requests in an isolate and would re-deadlock the correction flow).
  6 new unit tests + ADR 0004 updated.

### ADRs

- `docs/adr/0002-statement-month-export-scope.md`
- `docs/adr/0003-compliance-engine-finalize-gate.md`
- `docs/adr/0004-split-lock-model-cash-receipts.md` (updated for F1–F3)
- `docs/adr/0005-multi-open-month-assumption.md`

### What the Mac must do before deploy (MERGE GATE — do not skip)

1. **Apply migration 0017 to live D1:**
   `npx wrangler d1 migrations apply RECEIPTS_DB --remote`
2. **`npx tsc --noEmit`** green.
3. **`npm test`** green (237 tests as of F3).
4. **`npm run build:cf`** green.
5. **`cf:dev` smoke — draft → finalize → revision → re-finalize round-trip
   on a real month.** Required sequence (was A8 + F4 expanded):
   - Pick a test month with at least one AMEX line and one CASH receipt.
     Create one if needed via the existing flows.
   - Build a draft export for the month; verify preview rows match
     `buildExportBundle` output exactly (no `rows*135` estimate, real
     `sizeBytes`).
   - Finalize the export. Confirm the bundle ships with BOM-prefixed
     CRLF CSV, the `-summary.csv` is in R2 next to the manifest, and
     `receipt_export_items` has one row per bundle line.
   - Attempt a direct edit on a CASH receipt dated in that month →
     expect **409** with `ExportFinalizedError` naming
     `POST /api/receipts/export/<month>?correction=true`. **Must reject.**
   - `POST /api/receipts/export/<month>?correction=true` with a
     `correction_reason` → expect a new draft export row, export_revision=2,
     supersedes_export_id set.
   - **(F1 critical step)** Edit the same CASH receipt that just 409'd →
     expect **200 success**, not 409. The draft revision must release
     the lock. **If this still 409s, F1 did not land — stop and report
     back to the architect.**
   - Add or edit a second receipt in the same month to confirm the lock
     stays released while the draft exists.
   - Finalize the revision → expect revision-2 bundle to ship to R2 with
     `SupersedesExportId` in the manifest, fresh SHA-256, and a new row
     in `receipt_export_items`.
   - **(F3 critical step)** Attempt another direct edit on a CASH receipt
     in that month → expect **409** again. Finalizing the revision must
     re-close the lock.
6. **Out-of-order finalize warning smoke.** With month N finalized and
   month N-1 still open, finalize N-1. The response must include
   `warnings: ["..."]` referencing the earlier open month.
7. **Cross-month match blocker smoke.** Manually match the same receipt
   to AMEX lines in two open months. Finalize on either month must fail
   with the cross-month-match blocker. Unmatch from one month; finalize
   must succeed.
8. **`bash scripts/check-deployment.sh <base-url>`** after deploy.
9. Report back: which smoke steps passed/failed, any R2/D1 surprises,
   the `wrangler d1 migrations list RECEIPTS_DB --remote` output showing
   0017 applied.

If any **bolded** step fails, stop and report back to the architect
before merging. The correction round-trip is the load-bearing test for
the F1 fix; the unit tests prove the predicate but only the live D1
round-trip proves the wiring through `createExportRevision` →
`updateReceiptRecord` → `finalizeExport`.

---

## Notes for the worker

- This file (`docs/audits/export-remediation-2026-07-pr-notes.md`) is
  the source of truth for the PR description. The architect authored it
  in the sandbox session; paste the section between the `---` lines into
  the `gh pr create --body` heredoc.
- The smoke-test list is intentionally explicit because the F1 fix's
  correctness is not visible from the diff alone — the wiring through
  `createExportRevision` (which creates the draft row that releases the
  lock) only matters at runtime against real D1.
- Do NOT mark the F1 step optional even if every unit test passes. The
  unit tests prove the predicate logic; they do not prove that
  `createExportRevision` actually inserts the draft row that
  `isMonthLockedForEdits` queries, nor that `updateReceiptRecord`'s
  `assertTransactionMonthEditable` call uses the same D1 binding.
