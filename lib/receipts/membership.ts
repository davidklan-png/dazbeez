// ADR 0008 — calendar-month membership helpers for non-AMEX receipts.
//
// The PURE assignment math lives in statement-window.ts (naturalMonth +
// assignReceiptMembership + incrementMonth); this module loads its inputs from
// D1 and is where persistence decisions are made. Used by buildExportBundle
// (the bundle's non-AMEX selection), the capture/import-date-set assignment
// hooks, the gate-2 UNKNOWN scoping, and the discretionary override.
//
// CALENDAR RULE (ADR 0008, 2026-07-13): a CASH/DIGITAL receipt's export month is
// the calendar month of its transaction_date (June 11 → 2026-06), stored on
// receipt_records.export_statement_month (migration 0020). This RETIRES the ADR
// 0006 statement-cycle-window rule. Consequences carried over from 0006 and kept
// here: (a) sticky assignment — the automatic hooks only UPDATE
// `WHERE export_statement_month IS NULL`; (b) discretionary override to an open
// month, export-seal-guarded, audited; (c) roll-forward when the calendar month's
// export is finalized; (d) unassignable-undated receipts (NULL) surface for
// operator action. Consequences RETIRED: the "awaiting statement" state and its
// import sweep (a dated receipt is always immediately assignable under the
// calendar rule), and drift detection (membership no longer depends on AMEX line
// data, so no boundary can shift). See docs/adr/0008-…md.
//
// "Sealed" here = an export month that has SHIPPED and cannot be reopened
// (finalized AND no draft revision) — i.e. the isMonthLockedForEdits condition
// from month-lock.ts. Per ADR 0006 §D3 (unchanged by 0008): for CASH/DIGITAL the
// relevant lock is the EXPORT, not the reconciliation. A month whose
// reconciliation is sealed but whose export is still a draft can still accept a
// late cash receipt into its rebuildable bundle.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso } from "@/lib/receipts/db-utils";
import {
  assignReceiptMembership,
  naturalMonth,
  type AssignmentResult,
} from "@/lib/receipts/statement-window";
import type { PaymentPath, ReceiptRecord } from "@/lib/receipts/types";

/**
 * Export months sealed against new CASH/DIGITAL membership = exports that
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
 * UNKNOWN-path receipts "in scope" for export month M = those whose
 * transaction_date's CALENDAR month is M (ADR 0008). UNKNOWN has no stored
 * membership month, so its finalize-gate / tile scope is computed. Shared by the
 * finalize gate (gate 2) and the export tile so the two cannot drift. (Under ADR
 * 0006 this was a window compare; calendar month makes it a simple month match.)
 */
export async function listUnknownInScopeReceipts(
  month: string,
): Promise<ReceiptRecord[]> {
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
    (r) => naturalMonth(r.transaction_date) === month,
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

// ─── Unassigned-receipt surface (needs-attention residue) ──────────────────

/**
 * CASH/DIGITAL receipts with no export_statement_month assignment — the residue
 * the export page surfaces as needs-attention, deep-linked to each receipt's
 * review view. Two kinds land here:
 *   - undated (transaction_date IS NULL): can NEVER be assigned until a date is
 *     set; will never auto-resolve.
 *   - dated-but-unassigned: assignment slipped past the capture/classification
 *     hook (e.g. the UNKNOWN→CASH path before updateReceiptRecord's hook was
 *     broadened to fire on the effective post-PATCH state). A dated receipt is
 *     assignable to its calendar month — surfacing it keeps a future slip
 *     visible on the screen where it matters instead of silently shrinking the
 *     draft (error-surfacing doctrine, theme #12). The caller distinguishes the
 *     two by `transaction_date` (null ⇒ undated).
 * All are invisible to every membership query, which keys on
 * export_statement_month.
 */
export async function listUnassignableReceipts(): Promise<ReceiptRecord[]> {
  const db = getReceiptsDb();
  const res = await db
    .prepare(
      `SELECT * FROM receipt_records
       WHERE export_statement_month IS NULL
         AND payment_path IN ('CASH', 'DIGITAL')
         AND deleted_at IS NULL
       ORDER BY (transaction_date IS NULL) ASC, captured_at DESC`,
    )
    .all<ReceiptRecord>();
  return res.results ?? [];
}

/** Open (non-sealed) export months — the valid targets for a discretionary
 *  membership override (ADR 0008, reusing ADR 0006 §D6). A receipt may be
 *  reassigned to any open month; sealed months are blocked (the bundle already
 *  shipped). Sourced from receipt_exports (the months being exported) so the
 *  override dropdown is bounded to real export months. */
export async function listOpenExportMonths(): Promise<string[]> {
  const sealed = await loadSealedExportMonths();
  const db = getReceiptsDb();
  const res = await db
    .prepare(
      `SELECT DISTINCT export_month FROM receipt_exports ORDER BY export_month ASC`,
    )
    .all<{ export_month: string }>();
  return (res.results ?? [])
    .map((r) => r.export_month)
    .filter((m) => !sealed.has(m))
    .sort();
}

/** The natural (calendar) export month for a date — used to label the receipt's
 *  "natural" month next to an override. Null if the date is missing/malformed. */
export async function naturalMonthForDate(
  date: string | null,
): Promise<string | null> {
  return naturalMonth(date);
}

// ─── Assignment (capture / date-set) ────────────────────────────────────────

/**
 * Assign `export_statement_month` for one CASH/DIGITAL receipt, persisting it
 * + an audit row. Used at capture (when a date is supplied) and when a date is
 * first set on a previously-dateless receipt. Sticky-safe: the UPDATE is gated
 * on `export_statement_month IS NULL`, so a receipt that already has an
 * assignment (or got assigned concurrently) is not overwritten. A null/malformed
 * date returns null and writes nothing — the receipt stays NULL (unassignable)
 * until a valid date is set.
 *
 * Under ADR 0008 the assigned month is the calendar month of the date, with
 * roll-forward to the next open month if that calendar month's export is sealed.
 */
export async function assignMembershipForReceipt(
  receiptId: string,
  transactionDate: string | null,
  actor: string,
): Promise<AssignmentResult | null> {
  if (!transactionDate || !naturalMonth(transactionDate)) return null;
  const sealedMonths = await loadSealedExportMonths();
  const result = assignReceiptMembership(transactionDate, sealedMonths, {
    rollForward: true,
  });
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

/**
 * Decide whether the updateReceiptRecord membership hook should assign
 * export_statement_month after a PATCH, and with what date. Returns the date to
 * assign with, or null to skip. Pure (unit-tested); updateReceiptRecord applies
 * the side effect via {@link assignMembershipForReceipt}.
 *
 * Fires whenever the receipt is CASH/DIGITAL with a date and no existing
 * assignment — UNLESS the PATCH carries an explicit exportStatementMonth
 * override (explicit wins) or the receipt is already assigned (sticky). It does
 * NOT require the PATCH to touch the date, so the UNKNOWN→CASH classification
 * flow (date set while UNKNOWN, then classified CASH without re-touching the
 * date) assigns instead of leaving membership NULL and silently falling out of
 * the draft.
 */
export function postPatchMembershipDate(args: {
  effectivePaymentPath: PaymentPath;
  beforeExportStatementMonth: string | null;
  explicitOverrideInInput: boolean;
  effectiveTransactionDate: string | null;
}): string | null {
  if (args.effectivePaymentPath !== "CASH" && args.effectivePaymentPath !== "DIGITAL") {
    return null;
  }
  if (args.beforeExportStatementMonth) return null; // sticky — already assigned
  if (args.explicitOverrideInInput) return null; // explicit override wins
  if (!args.effectiveTransactionDate) return null; // nothing to assign from
  return args.effectiveTransactionDate;
}
