# ADR 0006 — Statement-window membership for non-AMEX receipts

- **Status:** Proposed (design-first; awaiting worker verification of prod before/after counts)
- **Date:** 2026-07-13
- **Owner:** David (PM) — policy operator-decided 2026-07-13
- **Affects:** `db/receipts/0020_*` (new), `lib/receipts/statement-window.ts`, `lib/receipts/month-closing.ts`, `lib/receipts/blockers.ts`, `lib/receipts/db.ts`, `lib/receipts/types.ts`, `lib/receipts/audit.ts`, `app/api/receipts/amex/import/route.ts`, `app/api/receipts/[id]/route.ts`, `components/receipts/export/review-screen.tsx`, `components/receipts/review/form-pane.tsx`, `components/receipts/export/export-screen.tsx`, `docs/month-close-runbook.md`, new `scripts/backfill-export-statement-month.ts`
- **Builds on:** [ADR 0002](./0002-statement-month-export-scope.md) (export unit = statement month), [ADR 0005](./0005-multi-open-month-assumption.md) (3–4 concurrent open months)
- **Supersedes:** the implicit "CASH/DIGITAL export month = `transaction_date` calendar month" rule in `buildExportBundle` (`lib/receipts/month-closing.ts:89-97`) and the `transaction_date LIKE 'YYYY-MM%'` scoping in finalize gates 2 / 2.5 (`lib/receipts/month-closing.ts:374-393`)

---

## TL;DR

Today a CASH/DIGITAL receipt's export month is derived from its **calendar** `transaction_date` (`LIKE '2026-06%'`). But an AMEX statement labeled `2026-06` covers a **cycle** of transactions dated **Apr 10 – May 7** (ADR 0002). So the "June" export ships June-dated cash receipts alongside April/May-dated AMEX lines — two different time periods in one bundle. That is accounting nonsense: a cash receipt spent on **May 3** belongs with the expenses from the **same billing cycle** (the 2026-06 statement), not with whatever calendar month its date happens to print.

This ADR makes export membership for non-AMEX receipts **by statement window**, not calendar month. Each receipt gets a stored, sticky `export_statement_month` computed from chained statement-cycle boundaries. The 2026-06 bundle recomposes: June-dated cash moves **out**, late-April/early-May-dated cash moves **in**. 2026-06 is not sealed, so this recomposition is expected and safe.

---

## Context

### What exists today (verified 2026-07-13)

- **`buildExportBundle(month)`** (`lib/receipts/month-closing.ts:65-189`) selects non-AMEX receipts via `listAllReceiptsInMonth(month, { paymentPath })`, which filters **`transaction_date LIKE 'YYYY-MM%'`** (`lib/receipts/db.ts:331-334`). AMEX receipts enter the bundle only as `matched_receipt_id` joins onto `amex_statement_lines` selected by `statement_month`.
- **`deriveStatementWindow(lines, month, slackDays=5)`** (`lib/receipts/statement-window.ts:25-52`) returns `{ start: min(tx)−5d, end: max(tx)+5d, source }`. This is the **match window** — used to find receipt candidates that *might* match AMEX lines during reconcile. It is slack-padded on both sides and is **not** a cycle-boundary chain.
- **No persisted statement close/start date exists anywhere.** `amex_statement_artifacts` (`db/receipts/0005_amex_extended.sql:22-44`) carries `statement_month` (the `YYYY-MM` label) and `payment_due_date` (the CSV `お支払日` — a **billing due date**, ~3 weeks *after* the cycle closes), but no `cycle_start` / `cycle_end` / `close_date`. The cycle range is only ever *derived* from `min/max(transaction_date)` over the statement's lines.
- **`receipt_records`** has no `export_statement_month` / `assigned_month` column. The closest is `exported_month` (`0001_init.sql:30`) — a post-export write-back, not a selection filter.
- **Finalize gate** `validateMonthReadyForExportCore` (`month-closing.ts:249-353`) scopes gates 2 (UNKNOWN) and 2.5 (unreviewed) by `transaction_date LIKE month%` (`month-closing.ts:374-393`) — the **same** calendar-month scoping that is inconsistent with statement-month export scope. Gate 3 iterates `bundle.receipts`, so it inherits whatever scoping `buildExportBundle` uses.
- **Shared predicates** (`lib/receipts/blockers.ts`, PR #80) — `isUnknownPathReceipt`, `isUnreviewedReceipt`, `computeExportBlockers`. Contract: a rule that should block finalize lives in `blockers.ts` **and** is wired into the gate.
- **Audit:** `receipt_audit_log` + `createAuditEntry(db, {actor, action, objectType, objectId, oldValueJson?, newValueJson?})` (`lib/receipts/audit.ts:5`). `AuditAction` is a union (`types.ts:99-137`).
- **Migrations:** `db/receipts/NNNN_snake.sql` (0001–0019 exist; next is **0020**), applied by `wrangler d1 migrations apply` (CI: `.github/workflows/deploy.yml:84`, before worker deploy). One-off data-fix SQL lives in `db/receipts/scripts/`; TS one-offs live in `scripts/` (precedent: `scripts/reprocess-extraction.ts`).

### The operator policy (decided 2026-07-13 — do not deviate)

1. Export membership for CASH/DIGITAL receipts is by **statement window**, not calendar month.
2. Windows are **contiguous and non-overlapping by construction**: `window(M) = (close(M−1), close(M)]`, where `close(M)` is statement M's window end. Earliest statement gets an open-ended start. A `transaction_date` maps to exactly one window.
3. **Sticky:** once assigned, immutable except a discretionary operator **override** to another **open** month — override is audited (old, new, actor) and blocked for sealed months.
4. Receipts dated **beyond the newest imported statement's close** → **UNASSIGNED** ("Awaiting statement" bucket), auto-assigned when the covering statement imports. Excluded from every bundle and every finalize gate (not blockers).
5. **Late captures** whose covering month is already sealed → **auto-roll-forward** to the next open statement month, with an audit entry recording natural window vs assigned month.
6. **Duplicate guard** (non-blocking warning): 2+ CASH/DIGITAL receipts sharing merchant + amount + `transaction_date`.

---

## Decision

### D1. `close(M)` = `MAX(transaction_date)` over the statement's AMEX lines — NOT `payment_due_date`, and with ZERO slack

This is the load-bearing design decision and the operator explicitly delegated it ("inspect `deriveStatementWindow` / `amex_statement_artifacts` for the best close-date source"). Two candidate anchors exist:

| Anchor | What it is | Why rejected / accepted |
|---|---|---|
| `amex_statement_artifacts.payment_due_date` | CSV `お支払日` — the **billing due date**, ~3 weeks *after* the cycle closes | **Rejected.** A due date of ~Jun 27 for the 2026-06 statement would put `window(2026-06) = (May 27, Jun 27]`, which **excludes** a May-3 cash receipt that plainly belongs to the 2026-06 cycle. It assigns by *when you pay the bill*, not *when you spent the money*. |
| `MAX(transaction_date)` over `amex_statement_lines WHERE statement_month = M` | the **actual last transaction** in the cycle (≈ May 7 for 2026-06) | **Accepted.** This *is* the cycle end. `window(2026-06) = (close(2026-05), close(2026-06)] ≈ (Apr 9, May 7]` correctly contains May 3 → 2026-06. |

**Worked example (the whole rationale):** statements run ~monthly and cycle transaction-dates are contiguous (`close(2026-05) ≈ Apr 9`, `close(2026-06) ≈ May 7`):

```
close(2026-04) ≈ Mar 9      close(2026-05) ≈ Apr 9      close(2026-06) ≈ May 7
       |        window(2026-05)=(Mar9,Apr9]       |  window(2026-06)=(Apr9,May7]  |
                            ↑ Apr 1 cash → 2026-05              ↑ May 3 cash → 2026-06 ✓
```

A cash receipt dated **May 3** lands in `window(2026-06)` → ships in the **June** export, alongside the AMEX lines from the *same* Apr 10–May 7 cycle. That is the accounting-correct grouping.

**Zero slack for membership.** `deriveStatementWindow`'s `slackDays=5` exists to generously cast a *match-candidate* net during reconcile — it must **not** leak into membership. With slack, `close(M)` would slide ~5 days past the real cycle end and **steal early-cycle dates into the prior month** (an Apr-11 receipt would mis-file as 2026-05 instead of 2026-06). So membership windows are a **separate** pure function with slack = 0; `deriveStatementWindow` stays untouched (it still serves reconcile).

### D2. Membership window math (pure, unit-tested) — new exports in `lib/receipts/statement-window.ts`

Co-located with `deriveStatementWindow` (same concept, different purpose). `deriveStatementWindow` and `isReceiptInWindow` are **unchanged**.

```ts
// New, pure, no D1. Inputs come from a single GROUP BY over amex_statement_lines.
export interface StatementClose { statementMonth: string; close: string /* YYYY-MM-DD */ }

export interface MembershipWindow {
  statementMonth: string;
  /** Exclusive lower bound. null for the earliest statement (open-ended start). */
  startExclusive: string | null;
  /** Inclusive upper bound = close(M). */
  endInclusive: string;
}

/** Chain closes into contiguous (close(M-1), close(M)] windows. Statements
 *  without a usable close (no lines / unparseable dates) are dropped — they
 *  cannot anchor a cycle and would create gaps. Sorted by statementMonth. */
export function computeStatementWindows(closes: StatementClose[]): MembershipWindow[];

/** The window a transaction_date falls in, or null if date > newest close
 *  (awaiting) or no windows exist. Single-membership by construction:
 *  boundaries are `endInclusive` of one window === `startExclusive` of the next,
 *  with start exclusive and end inclusive. */
export function assignStatementMonth(date: string, windows: MembershipWindow[]): string | null;

/** The natural month ignoring sealed-state / roll-forward. Convenience for
 *  gate-2 (UNKNOWN) scoping and the "expected future month" UI hint. */
export function naturalStatementMonth(date: string, windows: MembershipWindow[]): string | null;
```

**Invariants (each gets a unit test):**

- **Contiguity:** for `i > 0`, `windows[i].startExclusive === windows[i-1].endInclusive`.
- **Non-overlap:** a date maps to at most one window (boundary `B = close(M)`: `date ≤ B` ⇒ month M; `date > B` ⇒ month M+1; `date == B` ⇒ month M, since end is inclusive and the next start is exclusive).
- **Single membership:** every `transaction_date` that is `≤ newest close` resolves to exactly one month (or the earliest, whose start is open).
- **Awaiting:** `date > newest close` ⇒ `null`.
- **Open start:** any date `≤ close(earliest)` ⇒ earliest month.
- **Freeze (sticky wins over recomputation):** once a receipt has a non-null `export_statement_month`, a later shift in any `close(M)` **never** re-derives it. The import-sweep predicate is `WHERE export_statement_month IS NULL` by contract, so an assigned receipt is structurally invisible to re-derivation regardless of how windows move. (See D3 for the drift consequence.)

### D3. Assignment algorithm with stickiness, roll-forward, and awaiting

Single entry point used by **both** the capture path and the statement-import sweep:

```ts
export interface AssignmentResult {
  month: string | null;                 // null = awaiting
  reason: "natural" | "roll-forward" | "awaiting" | "awaiting-rolled";
  rolledFrom?: string;                  // natural month when rolled / rolled-awaiting
}

/** @param sealedMonths finalized statement_months (amex_reconciliations.status='finalized').
 *  CASH/DIGITAL only (policy). UNKNOWN does not roll — it must be classified first. */
export function assignReceiptMembership(
  date: string | null,
  windows: MembershipWindow[],
  sealedMonths: Set<string>,
  opts: { rollForward: boolean },
): AssignmentResult;
```

Logic:
1. `natural = naturalStatementMonth(date, windows)`. If `date` is null or `natural` is null ⇒ `{ month: null, reason: "awaiting" }`.
2. If `natural` not in `sealedMonths` ⇒ `{ month: natural, reason: "natural" }`.
3. Else (natural is sealed): if `!rollForward` ⇒ still assign `natural` (caller is UNKNOWN, or a context that doesn't roll). If `rollForward` ⇒ walk forward through `windows` by `statementMonth` order to the first month **not** in `sealedMonths`:
   - found ⇒ `{ month, reason: "roll-forward", rolledFrom: natural }`;
   - walked off the end (no newer open month) ⇒ `{ month: null, reason: "awaiting-rolled", rolledFrom: natural }`.

`rollForward = true` for CASH/DIGITAL; `false` for UNKNOWN (and AMEX never reaches here — see D4).

**Stickiness / Freeze rule.** `export_statement_month` is set **once** — at capture, or at the import-sweep for receipts that were awaiting. The import-sweep targets only `WHERE export_statement_month IS NULL AND payment_path IN ('CASH','DIGITAL')`; already-assigned receipts are structurally invisible to it. The only mutation after assignment is an operator override (D6).

**Why the freeze is load-bearing:** `close(M) = MAX(transaction_date)` is only as stable as the statement. A re-import or amendment that appends a **later-dated** AMEX line moves `close(M)` later — and that boundary was already used to assign receipts into `window(M+1)`. Re-deriving would silently relocate already-shipped-or-staged receipts between months. So:

> **Sticky assignments always win over window recomputation. If a re-import shifts a `close` date, existing assignments are never re-derived; the mismatch is logged to audit and surfaced as a warning — nothing more.**

Drift handling (wired in PR #2's import path, D8): after `importAmexLines`, recompute windows and, for every assigned CASH/DIGITAL receipt, compare `stored export_statement_month` vs `naturalStatementMonth(date, recomputedWindows)`. Where they differ:
- **Do not reassign** (freeze).
- Write one `createAuditEntry(action: "receipt.export_statement_month_window_drift", oldValueJson: {stored}, newValueJson: {recomputed_natural, shifted_close_month})` per drifted receipt.
- Collect drifted receipts into a non-blocking **"membership drift"** warning surfaced on the export tile (`computeExportWarnings`, D9) and the review screen, so the operator sees the mismatch and can override (D6) if they disagree. No automatic correction.

This turns a silent boundary shift into a visible, operator-judged event. The drift *detection* wiring is PR #2; the *invariant* (NULL-only sweep ⇒ no re-derivation) is a PR #1 contract stated now and pinned by a unit test.

### D4. Scope of the new column: CASH/DIGITAL only (strict policy); UNKNOWN handled at gate time

Per the policy's literal "CASH/DIGITAL" wording, `export_statement_month` is **written only for CASH/DIGITAL receipts**. AMEX receipts keep line-based membership (column stays NULL — their month is the matched line's `statement_month`, unchanged). UNKNOWN receipts are **not** assigned a stored month.

**However**, gate 2 (UNKNOWN) and gate 2.5 (unreviewed) currently scope by `transaction_date LIKE month%` — which is the *same* calendar-month scoping this ADR retires. They **must** be re-scoped to statement-cycle membership, or a June-dated UNKNOWN/unreviewed receipt would wrongly block the 2026-06 (Apr–May cycle) export. So:

- **Gates 2 / 2.5 / 3 for CASH/DIGITAL** scope by `export_statement_month = M` (stored).
- **Gate 2 (UNKNOWN)** scopes by `naturalStatementMonth(transaction_date, windows) === M`, computed in-memory via the *same* pure function (no logic fork). UNKNOWN receipts whose natural month is null (beyond newest close) block **nothing** — they are not in any real statement month's scope; they simply remain unclassified and surface in the existing "unknown payment path" tile when their month arrives.
- This is a **necessary consequence** of statement-cycle scope (ADR 0002 applied to the gate), not a policy deviation.

> *Alternative considered (rejected for policy fidelity):* also store `export_statement_month` on UNKNOWN receipts to make all gate scoping a uniform `WHERE export_statement_month = M`. Cleaner SQL, but writes membership data for receipts the policy scopes to CASH/DIGITAL. Rejected; noted here as a one-line scope change if the operator later prefers it.

### D5. Schema — additive migration `0020_export_statement_month.sql`

```sql
-- 0020_export_statement_month.sql
-- ADR 0006: stored, sticky statement-cycle membership for non-AMEX receipts.
-- Additive only — no existing column altered/dropped. NULL = not yet assigned
-- (awaiting statement) for CASH/DIGITAL; always NULL for AMEX/UNKNOWN.
ALTER TABLE receipt_records ADD COLUMN export_statement_month TEXT;

-- Hot path: buildExportBundle(M) selects non-AMEX receipts by this column.
-- Partial to keep the index lean and to match data semantics (only CASH/DIGITAL
-- carry a value). Deleted rows excluded (deleted_at IS NULL handled at query time).
CREATE INDEX IF NOT EXISTS idx_receipts_export_statement_month
  ON receipt_records(export_statement_month)
  WHERE payment_path IN ('CASH', 'DIGITAL');
```

`ReceiptRecord` gains `export_statement_month?: string | null` (`types.ts:206-257`). `UpdateReceiptInput` gains `exportStatementMonth?: string | null` (`types.ts:529-556`). New `AuditAction` values appended to the union (`types.ts:99-137`):

- `receipt.export_statement_month_assigned` — system, at capture/import-sweep.
- `receipt.export_statement_month_overridden` — operator override (old/new in JSON).
- `receipt.export_statement_month_rolled_forward` — system roll-forward (natural vs assigned in JSON).
- `receipt.export_statement_month_window_drift` — system, when a re-import shifts a `close` date and a stored assignment no longer matches the recomputed natural month (freeze rule, D3). Logged, never re-derived.

**Migration applies via CI** (`.github/workflows/deploy.yml:84`) before the worker deploy. The migration is column + index only — it carries **no** backfill, because roll-forward + per-row audit logging require the TS module (D7).

### D6. Override (discretionary, audited, open-months-only)

- **UI:** a `SelectInput` of **open** statement months (imported months whose reconciliation is not finalized) added to `components/receipts/review/form-pane.tsx` `FormPane`, plus a read-only "natural month" label. Included in the existing debounced PATCH body (`form-pane.tsx:180-194`) as `exportStatementMonth`.
- **Server:** `app/api/receipts/[id]/route.ts` PATCH handler accepts `exportStatementMonth`; before writing, assert the **target** month is open (`getFinalizedReconciliationForMonth(target) === null`), else 422. The receipt's **current** month being sealed is already blocked by the existing guards (`rejectIfReceiptInFinalizedReconciliation` `db.ts:281-300`; `assertTransactionMonthEditable` `month-lock.ts:178`), so override only applies to receipts in open months targeting open months.
- **Audit:** `createAuditEntry` with `action: "receipt.export_statement_month_overridden"`, `oldValueJson: {export_statement_month}`, `newValueJson: {export_statement_month: target}`, `actor` = the Clerk user.

### D7. Backfill — migration-adjacent TS script `scripts/backfill-export-statement-month.ts`

Precedent: `scripts/reprocess-extraction.ts` (TS one-off that writes D1 + audit). The script:

1. Loads all `StatementClose` from `amex_statement_lines` (`GROUP BY statement_month → MAX(transaction_date)`).
2. Loads `sealedMonths` from `amex_reconciliations WHERE status='finalized'`.
3. Computes `windows = computeStatementWindows(closes)` once.
4. Selects `WHERE export_statement_month IS NULL AND payment_path IN ('CASH','DIGITAL') AND deleted_at IS NULL AND transaction_date IS NOT NULL`.
5. For each: `assignReceiptMembership(date, windows, sealedMonths, { rollForward: true })`, `UPDATE receipt_records SET export_statement_month=?`, and `createAuditEntry(action: assigned | rolled_forward, oldValueJson: null, newValueJson: {month, reason, rolledFrom?})`.
6. **Idempotent** (`WHERE … IS NULL`) — safe to re-run; receipts captured between PR #1 and PR #2 are picked up by a re-run or by PR #2's import-sweep.
7. Prints a summary: counts by reason (natural / roll-forward / awaiting), per-month distribution, the window table.

**Run by the worker against remote, backup first** (`wrangler d1 backup` / export snapshot), per the established protocol. The script does **not** run in CI.

### D8. `buildExportBundle` switch + assignment wiring (behavior change, PR #2)

- New DB helper `listReceiptsByExportStatementMonth(month, paymentPaths)` in `lib/receipts/db.ts`:
  ```sql
  SELECT * FROM receipt_records
  WHERE deleted_at IS NULL
    AND export_statement_month = ?
    AND payment_path IN ('CASH','DIGITAL')
  ORDER BY transaction_date ASC
  ```
  Replaces the two `listAllReceiptsInMonth(month, {paymentPath})` calls in `buildExportBundle` (`month-closing.ts:89-97`). Dedup against `matchedReceiptMap` is retained (a CASH receipt that is also matched to a line still appears once, on the line row).
- **Capture path** (`createReceipt` / `db.ts` insert + the mobile/upload routes): after insert, compute `assignReceiptMembership` and set `export_statement_month` for CASH/DIGITAL. (At capture the date may be beyond the newest close ⇒ awaiting / NULL — correct.)
- **Statement-import path** (`app/api/receipts/amex/import/route.ts`, after `importAmexLines` ~line 246): run the assignment sweep for unassigned CASH/DIGITAL receipts (the new statement's window now covers some previously-awaiting dates; roll-forward applies to any whose natural month is sealed). Then run the **drift check** (D3 freeze rule): recompute windows from the now-updated lines and, for assigned CASH/DIGITAL receipts whose stored month ≠ recomputed natural month, write a `receipt.export_statement_month_window_drift` audit entry and collect them into the membership-drift warning. **Do not reassign.**
- **Gates** (`validateMonthReadyForExport` / `…Core`): re-scope per D4 — gate 2/2.5 queries move from `transaction_date LIKE ?` to `export_statement_month = ?` for CASH/DIGITAL, and UNKNOWN is loaded then filtered by `naturalStatementMonth === M` in TS. Add the membership rule to `lib/receipts/blockers.ts` per the PR #80 contract (a shared predicate + wire into the gate); the tile's month-scoped receipt fetch (in the export/review pages) must also re-scope to `export_statement_month` so tile ⇄ gate stay aligned. Awaiting (NULL) receipts are excluded from bundle and gates by construction.

### D9. Duplicate-receipt warning (non-blocking, policy point 6)

New shared pure function in `lib/receipts/blockers.ts`:

```ts
/** 2+ CASH/DIGITAL receipts sharing merchant + amount_minor + transaction_date.
 *  Warning only (e.g. 3× ¥10,000 Seven-Eleven on 06-11). Surfaces on review +
 *  reconcile-adjacent tiles via computeExportWarnings. */
export function computeDuplicateReceiptWarnings(receipts: ReceiptRecord[]): Blocker[];
```

Severity `warn`. Surfaced through `computeExportWarnings` (extend its signature to accept the month's receipts) on the export tile and the review screen. **No auto-dedup.**

The **membership-drift** warning from the freeze rule (D3) flows through the same `computeExportWarnings` channel — one warn entry per drifted receipt (or a single aggregated "N receipts drifted after statement re-import" tile), linking the operator to override (D6). Like the duplicate warning, it is non-blocking: drift is information, not a finalize gate.

### D10. UI touchpoints (PR #3)

1. **"Additional charges" header + dates** — `components/receipts/export/review-screen.tsx` `AdditionalChargesSection` (lines 442-484): add the **membership window** range to the header ("Additional charges · cycle Apr 10 – May 7"), sourced from `computeStatementWindows` for month M (rendered as `(prevClose+1) .. close`). Each row already exposes `transactionDate` (`ExportRow.transactionDate`) — keep showing it so the operator sees the date that placed the receipt in this cycle. Pass the membership window from the route `app/(receipt-system)/receipts/export/[month]/review/page.tsx` (which already calls `buildExportBundle`). Do **not** confuse with the existing slack-5 "Statement window" label in `ReviewHeader` (lines 94-162) — that is the match window; relabel if adjacency is confusing.
2. **"Awaiting statement" card** — `components/receipts/export/export-screen.tsx` (export index, global — these receipts belong to no month). Lists CASH/DIGITAL receipts with `export_statement_month IS NULL`, each with transaction_date, merchant, amount, and an **expected future month** hint (= `naturalStatementMonth` if a future cycle can be inferred, else "next statement"). New server fetch in `app/(receipt-system)/receipts/export/page.tsx`.
3. **Override control** — `components/receipts/review/form-pane.tsx` `FormPane` (D6).
4. **Duplicate warning** — review screen + export tile (D9).

### D11. Runbook — `docs/month-close-runbook.md`

Update "The statement month vs transaction dates" (lines 21-33) and "Blockers" (lines 35-52): document the new membership rule (cash/digital grouped by cycle, not calendar month), the "Awaiting statement" bucket, the override procedure (open months only, audited), and late-receipt roll-forward. Add a row to the blockers table for the duplicate warning.

---

## PR breakdown (3 PRs + 1 additive migration)

### PR #1 — Schema + pure module + backfill + this ADR *(design-first; additive, no behavior change)*

- `db/receipts/0020_export_statement_month.sql` (D5).
- `lib/receipts/statement-window.ts`: add `computeStatementWindows`, `assignStatementMonth`, `naturalStatementMonth`, `assignReceiptMembership` + types (D2, D3). `deriveStatementWindow`/`isReceiptInWindow` untouched.
- `lib/receipts/types.ts`: `ReceiptRecord.export_statement_month`, `UpdateReceiptInput.exportStatementMonth`, 3 new `AuditAction` values (D5).
- `tests/receipts/statement-window.test.ts`: the invariant tests (D2) — contiguity, non-overlap, single-membership, boundary dates, gap handling, **freeze (sticky-wins-over-recomputation: an assigned receipt is unaffected by a later `close` shift)** — + assignment tests incl. roll-forward / awaiting / sealed.
- `scripts/backfill-export-statement-month.ts` (D7).
- This ADR.
- **No behavior change:** `buildExportBundle` and the gates still use the old `transaction_date` filter. The column is populated but unread. Safe to deploy and sit.
- **Worker handoff (verification before merge):** backup prod → run the **read-only preview SQL** below → run the backfill script → re-run preview to confirm → report: (a) window table (month → prev_close, close, line_count), (b) 2026-06 before/after composition, (c) count left in "awaiting statement", (d) roll-forward count. Put the numbers in the PR body.
- tsc / lint / full tests pass.

### PR #2 — Behavior switch: bundle + assignment wiring + gate re-scoping

- `buildExportBundle` → `listReceiptsByExportStatementMonth` (D8).
- Capture-path + statement-import assignment (D8).
- Gate re-scoping (gates 2/2.5/3 + tile) + shared predicate in `blockers.ts` (D4, D8).
- Update `tests/receipts/month-closing.test.ts`, `export.test.ts`.
- PR body: restate the 2026-06 recomposition with the prod before/after from PR #1, and confirm awaiting receipts no longer block finalize.
- tsc / lint / full tests; `npm run build:cf`; smoke after deploy.

### PR #3 — UI + duplicate warning + runbook

- Additional-charges window header + transaction dates (D10.1).
- "Awaiting statement" card (D10.2).
- Override control + PATCH handler + sealed-target guard + audit (D6, D10.3).
- Duplicate warning (D9, D10.4).
- `docs/month-close-runbook.md` (D11).
- UI + warning tests; smoke after deploy.

> PR #2 and #3 can be merged into one if review prefers, but keeping the behavior switch separate from UI makes the recomposition auditable on its own.

---

## Read-only preview SQL (worker runs against prod before backfill)

```sql
-- (a) Window table: each imported statement → membership window boundaries
SELECT statement_month,
       MIN(transaction_date) AS cycle_min,
       MAX(transaction_date) AS close,
       COUNT(*)              AS line_count
FROM amex_statement_lines
WHERE transaction_date IS NOT NULL
GROUP BY statement_month
ORDER BY statement_month;
-- prev_close = the close of the prior row; window(M) = (prev_close, close].

-- (b) BEFORE: 2026-06 export population under the OLD rule (calendar month)
SELECT payment_path, COUNT(*) AS n
FROM receipt_records
WHERE deleted_at IS NULL AND payment_path IN ('CASH','DIGITAL')
  AND transaction_date LIKE '2026-06%'
GROUP BY payment_path;

-- (c) AFTER (preview): 2026-06 population under the NEW rule (membership window)
WITH closes AS (
  SELECT statement_month, MAX(transaction_date) AS close
  FROM amex_statement_lines WHERE transaction_date IS NOT NULL
  GROUP BY statement_month
)
SELECT r.payment_path, COUNT(*) AS n
FROM receipt_records r
JOIN closes c06 ON c06.statement_month = '2026-06'
LEFT JOIN closes c05 ON c05.statement_month = (
  SELECT MAX(statement_month) FROM closes WHERE statement_month < '2026-06'
)
WHERE r.deleted_at IS NULL AND r.payment_path IN ('CASH','DIGITAL')
  AND r.transaction_date IS NOT NULL
  AND r.transaction_date <= c06.close
  AND (c05.close IS NULL OR r.transaction_date > c05.close)
GROUP BY r.payment_path;

-- (d) Awaiting statement (preview): CASH/DIGITAL beyond the newest close
WITH closes AS (
  SELECT MAX(close_d) AS newest FROM (
    SELECT MAX(transaction_date) AS close_d
    FROM amex_statement_lines WHERE transaction_date IS NOT NULL
    GROUP BY statement_month
  )
)
SELECT COUNT(*) AS awaiting
FROM receipt_records r, closes
WHERE r.deleted_at IS NULL AND r.payment_path IN ('CASH','DIGITAL')
  AND r.transaction_date > closes.newest;

-- (e) Roll-forward candidates (preview): CASH/DIGITAL whose natural window is sealed
WITH closes AS (
  SELECT statement_month, MAX(transaction_date) AS close
  FROM amex_statement_lines WHERE transaction_date IS NOT NULL GROUP BY statement_month
),
sealed AS (
  SELECT statement_month FROM amex_reconciliations WHERE status='finalized'
)
SELECT r.id, r.transaction_date, r.merchant, nat.natural_month
FROM receipt_records r
JOIN closes c ON c.statement_month = (
  SELECT MIN(statement_month) FROM closes WHERE close >= r.transaction_date
)
LEFT JOIN sealed s ON s.statement_month = c.statement_month
... -- (worker: finish the natural-month join; the TS backfill is authoritative for roll-forward)
```

(a)–(d) are the numbers that go in the PR #1 body. (e) is a sanity cross-check against the script's roll-forward count.

---

## Consequences

- **2026-06 recomposes** (it is not sealed — safe). June-dated CASH/DIGITAL receipts **leave** the 2026-06 bundle (they belong to the 2026-07 cycle or are awaiting); late-April / early-May-dated CASH/DIGITAL receipts **enter** it. Before/after counts come from prod (preview SQL above) and land in the PR #1 body.
- **A receipt's export month is now stable across statement re-imports** (sticky), removing a class of "the bundle changed under me" surprises. The cost is the override procedure when the operator disagrees with the computed month.
- **Awaiting receipts never block finalize** — they are simply not in any month's scope. This closes the latent gate-2/2.5 calendar-vs-statement scoping drift (receipts dated in a statement's *label* month but outside its *cycle* no longer wrongly block).
- **Two window concepts now coexist** and must stay distinct in code and UI: the slack-5 **match window** (`deriveStatementWindow`, reconcile candidate filtering) and the slack-0 **membership window** (`computeStatementWindows`, export scoping). The runbook and the review-screen labels must not conflate them.
- **Roll-forward is sticky too** — once rolled, a receipt stays in its rolled month even if the natural month is later unsealed. Re-evaluating would require an explicit operator action (override). Acceptable: roll-forward exists precisely because the natural month's bundle already shipped.
- **`close(M)` depends on the AMEX line population, and the freeze rule governs what happens when it moves.** A statement re-import that appends a later-dated line shifts `close(M)` — possibly *after* `window(M+1)` assignments were already made. The freeze rule (D3) holds those existing assignments fixed: the import-sweep is `WHERE export_statement_month IS NULL`, so no assigned receipt is ever re-derived; instead each mismatch becomes a `receipt.export_statement_month_window_drift` audit entry + a non-blocking warning for the operator to override if they disagree. Deterministic, no silent relocations, no orphans, no duplicates. Gaps (an imported statement with zero lines) cannot anchor a window and are skipped — receipts in the gap fall to awaiting until covered. In steady state every imported statement has lines, so this is an edge case.
- **Statement cycles overlap in transaction dates — normal AMEX posting behavior, not a bug.** Observed in prod: 2026-07's earliest AMEX line is dated 2026-05-05, which sits *inside* 2026-06's window (Apr 10 – May 7). A charge can transact in one cycle and post to the next statement. This is harmless for cash membership (the window convention is a deterministic grouping, not a claim about card posting), but it is the concrete reason a boundary-date cash receipt may group with a different cycle than a same-day card charge — and why the discretionary override (§D6) exists to reconcile the two when the operator disagrees.
- No change to AMEX-path membership (still the matched line's `statement_month`). No change to the match window or reconcile matching. No change to finalize irreversibility or the two-lock model (reconciliation-seal / export-seal).
