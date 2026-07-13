# ADR 0008 — Calendar-month membership for non-AMEX receipts

- **Status:** Accepted (policy operator-decided 2026-07-13)
- **Date:** 2026-07-14
- **Owner:** David (PM) — policy operator-decided 2026-07-13
- **Affects:** `lib/receipts/statement-window.ts`, `lib/receipts/membership.ts`,
  `lib/receipts/types.ts`, `lib/receipts/db.ts`, `lib/receipts/month-closing.ts`,
  `lib/receipts/blockers.ts`, `app/api/receipts/amex/import/route.ts`,
  `app/api/receipts/[id]/route.ts`, `app/(receipt-system)/receipts/export/page.tsx`,
  `app/(receipt-system)/receipts/export/[month]/review/page.tsx`,
  `app/(receipt-system)/receipts/review/[id]/page.tsx`,
  `components/receipts/export/export-screen.tsx`,
  `components/receipts/export/review-screen.tsx`,
  `components/receipts/review/form-pane.tsx`,
  `tests/receipts/statement-window.test.ts`, `docs/month-close-runbook.md`,
  new `scripts/migrate-membership-to-calendar-month.ts`, deleted
  `scripts/backfill-export-statement-month.ts`
- **Builds on:** [ADR 0002](./0002-statement-month-export-scope.md) (export unit
  = statement month), [ADR 0005](./0005-multi-open-month-assumption.md) (≤2 open
  months), the migration-0017 export-revision machinery
- **Supersedes (in part):** [ADR 0006](./0006-statement-window-membership-for-non-amex-receipts.md)
  — its window-based membership rule (§D1 close-anchor, §D2 `computeStatementWindows`,
  §D3 window recomputation, §D4 UNKNOWN-window scoping), §D8 import sweep + drift
  detection, §D9 membership-drift warning, §D10.2 "Awaiting statement" card, and
  §D11 awaiting-state runbook text. **ADR 0006 is not rewritten** — it stands as
  the history of what shipped and what is now reversed. See the pointer added to
  its Status field.

---

## TL;DR

ADR 0006 made a CASH/DIGITAL receipt's export month the **statement-cycle window**
its `transaction_date` falls in (`window(M) = (close(M-1), close(M)]` chained from
AMEX line closes). The operator has reversed that for the books: a cash receipt
dated **June 11** belongs in the **June** export — the calendar month of its date
— sitting alongside the June *statement*, even though that statement's AMEX lines
span the *prior* billing cycle. The cycle/calendar asymmetry is intentional and
is now the documented requirement.

Membership becomes **calendar month** (`transaction_date.slice(0,7)`): a pure,
AMEX-line-independent computation. The sticky assignment column
(`receipt_records.export_statement_month`, migration 0020), the capture/date-set
hooks, roll-forward, the discretionary override, and the bundle/gate read paths
all stay; only the natural-month math flips and the window-dependent **awaiting**
state + **drift detection** are retired (they have no meaning when membership is
pure calendar). A one-time policy migration reassigns existing receipts.

## Context

### What ADR 0006 shipped (verified 2026-07-13)

- `export_statement_month` column + partial index (`db/receipts/0020_*`).
- Pure window math in `statement-window.ts`: `computeStatementWindows`,
  `assignStatementMonth`, `naturalStatementMonth`, `assignReceiptMembership(date,
  windows, sealedMonths, opts)`.
- D1 layer (`membership.ts`): `loadStatementWindows`, `loadSealedExportMonths`,
  `listUnknownInScopeReceipts`, `listReceiptsByExportStatementMonth`,
  `listAwaitingReceipts`, `nextExpectedStatementMonth`,
  `listUnassignableReceipts`, `listOpenStatementMonths`, `naturalMonthForDate`,
  `assignMembershipForReceipt`, `sweepUnassignedReceipts`, `detectMembershipDrift`.
- `buildExportBundle` selects non-AMEX receipts by `export_statement_month = M`.
- Capture + date-set assignment hooks; import-route sweep + drift detection.
- Override control (PATCH `/api/receipts/[id]`) with export-seal guard + audit.
- "Awaiting statement" + "Unassignable" cards on the export page; cycle-range
  header on the review page.

### The operator policy (decided 2026-07-13 — do not deviate)

1. A CASH/DIGITAL receipt's export month is the **calendar month** of its
   `transaction_date` (June 1–30 → `2026-06`), stored on `export_statement_month`.
2. **Sticky** (carried over from ADR 0006): once assigned, immutable except a
   discretionary operator **override** to another **open** month — override is
   audited (old, new, actor) and blocked for sealed months.
3. **Roll-forward** (carried over): if the calendar month's export is finalized,
   a newly-assigned receipt rolls to the next **open** month, with an audit entry
   recording natural vs assigned month.
4. **Undated** CASH/DIGITAL receipts are **unassignable** (NULL) — the "missing
   transaction date" card stays exactly as is.
5. **Statement windows remain for AMEX matching only** (`deriveStatementWindow`,
   reconcile candidate filtering) — untouched.

## Decision

### D1. Natural month = calendar month (replaces the window lookup)

`naturalMonth(transaction_date) = transaction_date.slice(0,7)` — pure, no D1, no
AMEX-line dependency. This replaces ADR 0006's `naturalStatementMonth(date,
windows)`. Reuses the same regex as `transactionMonthOf` (`lib/receipts/month-lock.ts`),
which already drives the split-lock guard.

### D2. Assignment (pure, unit-tested)

```ts
export function assignReceiptMembership(
  date: string,
  sealedMonths: Set<string>,
  opts: { rollForward: boolean },
): AssignmentResult;  // { month, reason: "natural" | "roll-forward", rolledFrom? }
```

1. `natural = naturalMonth(date)`. (Null/malformed dates are "unassignable" and
   are skipped by the caller before this is called.)
2. `natural` not sealed ⇒ `{ natural, "natural" }`.
3. `natural` sealed + `rollForward` ⇒ walk forward by calendar month to the first
   non-sealed month (bounded at 24; with ≤2 open months per ADR 0005 this is never
   reached, and the fallback returns `natural` so a receipt is never left
   unassigned). `rollForward=false` (UNKNOWN) keeps `natural` and blocks at gate 2.

`reason` loses ADR 0006's `"awaiting"` / `"awaiting-rolled"` values — a dated
receipt always resolves under the calendar rule.

### D3. What survives from ADR 0006 (unchanged machinery)

- The `export_statement_month` column + partial index (0020).
- Sticky / freeze rule: the capture (`createReceiptRecord`) and date-set
  (`updateReceiptRecord`) assignment UPDATEs are `WHERE export_statement_month IS
  NULL`; an assigned receipt is never re-derived. The only other writers are the
  override and the one-time policy migration.
- Roll-forward to the next open month when the calendar month's export is sealed.
- Discretionary override to an open month, export-seal-guarded (`loadSealedExportMonths`),
  audited `receipt.export_statement_month_overridden`.
- "Sealed" = finalized export with no draft revision (the `isMonthLockedForEdits`
  condition) — the EXPORT seal, not the reconciliation seal (ADR 0006 §D3
  correction holds).
- CASH/DIGITAL-only column scope; UNKNOWN scoped at gate time; AMEX unchanged.
- `buildExportBundle` selects non-AMEX receipts by `export_statement_month = M`
  — the read path is identical; only how the column is *populated* changed.

### D4. What ADR 0008 retires

- **Window math:** `computeStatementWindows`, `assignStatementMonth`,
  `naturalStatementMonth`, `MembershipWindow`, `StatementClose` — deleted from
  `statement-window.ts` (zero consumers remain).
- **Awaiting state:** `listAwaitingReceipts`, `nextExpectedStatementMonth`, the
  "Awaiting statement" UI card, the AMEX-import sweep
  (`sweepUnassignedReceipts`). A dated receipt is always immediately assignable
  to its calendar month, so there is no "beyond the newest close" bucket.
- **Drift detection:** `detectMembershipDrift`, the
  `receipt.export_statement_month_window_drift` audit action, the membership-drift
  warning, and the import-route hook that called both. Calendar membership has no
  AMEX-line dependency, so no boundary can shift — the entire premise of drift
  disappears.
- The superseded `scripts/backfill-export-statement-month.ts` (the ADR 0006 PR #1
  one-off) is deleted; it imported the removed window symbols.

### D5. UNKNOWN scoping simplifies

Gate 2 (UNKNOWN) and the export tile still call `listUnknownInScopeReceipts(M)`,
but it now filters UNKNOWN receipts whose `naturalMonth(transaction_date) === M`
(was a window compare). Gate 2.5 still scopes by `bundle.receipts ∪ UNKNOWN in
M`. No gate/tile logic changes beyond the internal natural-month computation —
the operator-confirmed "gates/tiles derive from bundle membership, verify they
follow the new rule" holds.

### D6. Override dropdown

`listOpenStatementMonths` (sourced from `amex_statement_lines`) is renamed
`listOpenExportMonths` and sourced from `receipt_exports.export_month` — the
months being exported, minus sealed. Bounds the override dropdown to real export
months under calendar membership.

### D7. One-time policy migration — `scripts/migrate-membership-to-calendar-month.ts`

Reassigns every DATED CASH/DIGITAL receipt to its calendar month. **Not** the
sticky NULL-only path — an explicit operator-directed overwrite (not a sticky
violation), audited per row as `receipt.export_statement_month_policy_migrated`
with `{old, new, reason:"ADR 0008 policy migration"}`. No-op rows (already on
their calendar month) are skipped for both UPDATE and audit, making a re-run
clean. Dry-run by default; `--write` to persist. Run from the Mac with bindings
after a D1 backup. `receipt.export_statement_month_window_drift` is removed from
the `AuditAction` union; `receipt.export_statement_month_policy_migrated` is added.

### Live data at migration (read-only preview, 2026-07-13)

- 12 dated CASH/DIGITAL receipts, **0 undated**. Current (window) assignment:
  11 → `2026-07`, 1 → NULL. The NULL receipt (`540a5714…`, dated `2026-06-02`)
  was "awaiting" under the window rule — **not** undated.
- Calendar result: 11 → `2026-06`, 1 → `2026-07`.
- **No export months sealed** → roll-forward triggers for no one; the migration is
  a straight overwrite.
- Expected migration effect: 10 × `2026-07`→`2026-06`, 1 × NULL→`2026-06`, 1 ×
  `2026-07`→`2026-07` (no-op), **0 NULL remain**. (The "undated one stays NULL"
  mental model was moot — the single NULL receipt was June-dated and becomes
  assignable.)

## Consequences

- **June seals with its June-dated cash in the bundle.** `buildExportBundle(2026-06)`
  = 32 AMEX lines + 11 June-dated cash receipts. The 4× セブン-イレブン ¥10,000
  2026-06-11 cluster now ships in June and the duplicate warning fires on June's
  review page.
- **Membership is now AMEX-line-independent** — a statement re-import can no longer
  shift a cash receipt's month. The cost was the drift-detection machinery; that
  cost is gone.
- **No awaiting state.** A captured, dated cash receipt is in a concrete export
  month immediately; the only NULL cash/digital receipts are undated (unassignable).
- **The cycle/calendar asymmetry is intentional and documented** (this ADR + the
  runbook): the June export contains June-dated cash *and* AMEX lines whose dates
  span the prior cycle. That is the operator's books.
- No schema change (column + index from 0020 reused). No AMEX-path, match-window,
  reconcile, or finalize-irreversibility change.

## Backlog seeded

[ADR 0009](./0009-sealed-month-amendment-policy.md) — sealed-month amendment
policy (design of record only, no implementation in this change).
