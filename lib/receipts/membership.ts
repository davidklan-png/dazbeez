// ADR 0006 — D1-backed statement-cycle membership helpers.
//
// The PURE window/assignment math lives in statement-window.ts; this module
// loads its inputs from D1 and is where persistence decisions are made. Used by
// buildExportBundle (PR #2 bundle flip), the capture/import assignment hooks,
// drift detection, and the finalize-gate / tile re-scoping.
//
// "Sealed" here = an export month that has SHIPPED and cannot be reopened
// (finalized AND no draft revision) — i.e. the isMonthLockedForEdits condition
// from month-lock.ts. Per ADR §D3 (corrected in this PR from the original
// reconciliation-sealed wording): for CASH/DIGITAL the relevant lock is the
// EXPORT, not the reconciliation. A month whose reconciliation is sealed but
// whose export is still a draft can still accept a late cash receipt into its
// rebuildable bundle, so the reconciliation seal must NOT trigger roll-forward.
// See the ADR §D3 correction note for the full rationale.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso } from "@/lib/receipts/db-utils";
import {
  assignReceiptMembership,
  computeStatementWindows,
  naturalStatementMonth,
  type AssignmentResult,
  type MembershipWindow,
  type StatementClose,
} from "@/lib/receipts/statement-window";
import type { PaymentPath, ReceiptRecord } from "@/lib/receipts/types";

/**
 * Membership windows computed from live AMEX line closes:
 * window(M) = (close(M-1), close(M)], close(M) = MAX(transaction_date) over
 * statement M's lines. Statements with no dated lines are dropped (cannot anchor
 * a window). See statement-window.ts / ADR §D2.
 */
export async function loadStatementWindows(): Promise<MembershipWindow[]> {
  const db = getReceiptsDb();
  const res = await db
    .prepare(
      `SELECT statement_month, MAX(transaction_date) AS close
       FROM amex_statement_lines
       WHERE transaction_date IS NOT NULL
       GROUP BY statement_month`,
    )
    .all<{ statement_month: string; close: string | null }>();
  const closes: StatementClose[] = (res.results ?? [])
    .filter((r) => Boolean(r.statement_month) && Boolean(r.close))
    .map((r) => ({ statementMonth: r.statement_month, close: r.close as string }));
  return computeStatementWindows(closes);
}

/**
 * Statement months sealed against new CASH/DIGITAL membership = exports that
 * shipped AND have no open draft revision (the isMonthLockedForEdits
 * condition). Roll-forward and the override both treat these as closed targets.
 */
export async function loadSealedExportMonths(): Promise<Set<string>> {
  const db = getReceiptsDb();
  const res = await db
    .prepare(
      `SELECT export_month FROM receipt_exports
       WHERE status = 'finalized'
         AND export_month NOT IN (
           SELECT export_month FROM receipt_exports WHERE status = 'draft'
         )`,
    )
    .all<{ export_month: string }>();
  return new Set((res.results ?? []).map((r) => r.export_month));
}

/**
 * UNKNOWN-path receipts "in scope" for statement month M = those whose
 * transaction_date's natural window is M. UNKNOWN has no stored membership
 * month, so its finalize-gate / tile scope is computed. An UNKNOWN receipt
 * dated beyond the newest close is "awaiting" and is in no month's scope
 * (blocks nothing). Shared by the finalize gate (gate 2) and the export tile
 * so the two cannot drift.
 */
export async function listUnknownInScopeReceipts(
  month: string,
): Promise<ReceiptRecord[]> {
  const windows = await loadStatementWindows();
  const db = getReceiptsDb();
  const res = await db
    .prepare(
      `SELECT * FROM receipt_records
       WHERE deleted_at IS NULL
         AND payment_path = 'UNKNOWN'
         AND transaction_date IS NOT NULL`,
    )
    .all<ReceiptRecord>();
  return (res.results ?? []).filter(
    (r) =>
      r.transaction_date !== null &&
      naturalStatementMonth(r.transaction_date, windows) === month,
  );
}
export async function listReceiptsByExportStatementMonth(
  month: string,
  paymentPaths: PaymentPath[] = ["CASH", "DIGITAL"],
): Promise<ReceiptRecord[]> {
  const db = getReceiptsDb();
  const placeholders = paymentPaths.map(() => "?").join(",");
  const res = await db
    .prepare(
      `SELECT * FROM receipt_records
       WHERE deleted_at IS NULL
         AND export_statement_month = ?
         AND payment_path IN (${placeholders})
       ORDER BY transaction_date ASC`,
    )
    .bind(month, ...paymentPaths)
    .all<ReceiptRecord>();
  return res.results ?? [];
}

// ─── Assignment (capture / update / import sweep) ──────────────────────────

/**
 * Assign `export_statement_month` for one CASH/DIGITAL receipt, persisting it
 * + an audit row. Used at capture (when a date is supplied) and when a date is
 * first set on a previously-dateless receipt. Sticky-safe: the UPDATE is gated
 * on `export_statement_month IS NULL`, so a receipt that already has an
 * assignment (or got assigned by a concurrent sweep) is not overwritten. A null
 * result (awaiting) writes nothing — the column stays NULL until a covering
 * statement imports and the sweep picks it up.
 */
export async function assignMembershipForReceipt(
  receiptId: string,
  transactionDate: string | null,
  actor: string,
): Promise<AssignmentResult> {
  if (!transactionDate) return { month: null, reason: "awaiting" };
  const [windows, sealedMonths] = await Promise.all([
    loadStatementWindows(),
    loadSealedExportMonths(),
  ]);
  const result = assignReceiptMembership(transactionDate, windows, sealedMonths, {
    rollForward: true,
  });
  if (result.month === null) return result;
  const db = getReceiptsDb();
  await db
    .prepare(
      `UPDATE receipt_records SET export_statement_month = ?, updated_at = ?
       WHERE id = ? AND export_statement_month IS NULL`,
    )
    .bind(result.month, nowIso(), receiptId)
    .run();
  await createAuditEntry(db, {
    actor,
    action:
      result.reason === "roll-forward"
        ? "receipt.export_statement_month_rolled_forward"
        : "receipt.export_statement_month_assigned",
    objectType: "receipt",
    objectId: receiptId,
    oldValueJson: null,
    newValueJson: JSON.stringify({
      export_statement_month: result.month,
      reason: result.reason,
      rolledFrom: result.rolledFrom ?? null,
    }),
  });
  return result;
}

export interface MembershipSweepSummary {
  processed: number;
  assigned: number;
  awaiting: number;
  rolledForward: number;
  byMonth: Record<string, number>;
}

/**
 * Assign every unassigned CASH/DIGITAL receipt (the freeze rule: only NULL
 * rows are touched). Loads windows + sealed months ONCE, then loops. Called by
 * the AMEX import route after lines land (a newly-imported statement's window
 * now covers previously-awaiting receipts) and reusable as a maintenance sweep.
 */
export async function sweepUnassignedReceipts(
  actor: string,
): Promise<MembershipSweepSummary> {
  const [windows, sealedMonths] = await Promise.all([
    loadStatementWindows(),
    loadSealedExportMonths(),
  ]);
  const db = getReceiptsDb();
  const res = await db
    .prepare(
      `SELECT id, transaction_date FROM receipt_records
       WHERE export_statement_month IS NULL
         AND payment_path IN ('CASH', 'DIGITAL')
         AND deleted_at IS NULL
         AND transaction_date IS NOT NULL`,
    )
    .all<{ id: string; transaction_date: string }>();
  const summary: MembershipSweepSummary = {
    processed: 0,
    assigned: 0,
    awaiting: 0,
    rolledForward: 0,
    byMonth: {},
  };
  for (const r of res.results ?? []) {
    summary.processed++;
    const result = assignReceiptMembership(r.transaction_date, windows, sealedMonths, {
      rollForward: true,
    });
    if (result.month === null) {
      summary.awaiting++;
      continue;
    }
    await db
      .prepare(
        `UPDATE receipt_records SET export_statement_month = ?, updated_at = ?
         WHERE id = ? AND export_statement_month IS NULL`,
      )
      .bind(result.month, nowIso(), r.id)
      .run();
    await createAuditEntry(db, {
      actor,
      action:
        result.reason === "roll-forward"
          ? "receipt.export_statement_month_rolled_forward"
          : "receipt.export_statement_month_assigned",
      objectType: "receipt",
      objectId: r.id,
      oldValueJson: null,
      newValueJson: JSON.stringify({
        export_statement_month: result.month,
        reason: result.reason,
        rolledFrom: result.rolledFrom ?? null,
      }),
    });
    summary.assigned++;
    if (result.reason === "roll-forward") summary.rolledForward++;
    summary.byMonth[result.month] = (summary.byMonth[result.month] ?? 0) + 1;
  }
  return summary;
}

/**
 * Freeze-rule drift detection (ADR §D3). Recomputes each assigned CASH/DIGITAL
 * receipt's membership from scratch (windows + sealed, with roll-forward) and
 * compares to the stored value. A mismatch means a close shifted, a month
 * sealed/unsealed, or the receipt was overridden — NEVER reassign (freeze); log
 * a `receipt.export_statement_month_window_drift` audit row per drifted receipt
 * and return the count so the import route can surface a non-blocking warning.
 *
 * Uses recompute (not a raw natural-month compare) so legitimate roll-forwards
 * don't false-positive: a rolled receipt recomputes to its rolled month while
 * the roll target is still the first open month past the sealed natural month.
 */
export async function detectMembershipDrift(actor: string): Promise<number> {
  const [windows, sealedMonths] = await Promise.all([
    loadStatementWindows(),
    loadSealedExportMonths(),
  ]);
  const db = getReceiptsDb();
  const res = await db
    .prepare(
      `SELECT id, transaction_date, export_statement_month FROM receipt_records
       WHERE export_statement_month IS NOT NULL
         AND payment_path IN ('CASH', 'DIGITAL')
         AND deleted_at IS NULL
         AND transaction_date IS NOT NULL`,
    )
    .all<{
      id: string;
      transaction_date: string;
      export_statement_month: string;
    }>();
  let drifted = 0;
  for (const r of res.results ?? []) {
    const recomputed = assignReceiptMembership(
      r.transaction_date,
      windows,
      sealedMonths,
      { rollForward: true },
    );
    if (recomputed.month !== r.export_statement_month) {
      drifted++;
      await createAuditEntry(db, {
        actor,
        action: "receipt.export_statement_month_window_drift",
        objectType: "receipt",
        objectId: r.id,
        oldValueJson: JSON.stringify({ export_statement_month: r.export_statement_month }),
        newValueJson: JSON.stringify({
          recomputed_month: recomputed.month,
          reason: recomputed.reason,
          rolledFrom: recomputed.rolledFrom ?? null,
          transaction_date: r.transaction_date,
        }),
      });
    }
  }
  return drifted;
}
