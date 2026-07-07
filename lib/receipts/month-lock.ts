// A small value-object that bundles "is this month finalized?" with the
// metadata UI surfaces need: a label, a reason for the lock, and a date.
// Pages fetch the finalized flag server-side and pass this down so client
// components can disable mutating controls upstream — instead of letting
// the user click a button and discover the 409 in a toast.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";

export type MonthLock = {
  /** True when the month is finalized (no further edits allowed). */
  locked: boolean;
  /** ISO timestamp the reconciliation was sealed, if any. */
  finalizedAt: string | null;
  /** Short label suitable for a Pill or badge ("Sealed" / "Draft"). */
  badge: "Sealed" | "Draft" | "Not built";
  /** One-line reason to surface in tooltips and confirm dialogs. */
  reason: string;
};

export function buildMonthLock(input: {
  finalized: boolean;
  finalizedAt?: string | null;
  hasDraft?: boolean;
}): MonthLock {
  if (input.finalized) {
    return {
      locked: true,
      finalizedAt: input.finalizedAt ?? null,
      badge: "Sealed",
      reason: "This month is finalized. Reopen reconciliation to edit.",
    };
  }
  if (input.hasDraft) {
    return {
      locked: false,
      finalizedAt: null,
      badge: "Draft",
      reason: "Reconciliation is in progress.",
    };
  }
  return {
    locked: false,
    finalizedAt: null,
    badge: "Not built",
    reason: "Reconciliation hasn't been started for this month.",
  };
}

// ─── Split lock model (audit A5) ─────────────────────────────────────────────
//
// Two independent locks govern month-end state, each blocking a different
// kind of edit:
//
//   1. Reconciliation-sealed (existing, in db.ts
//      rejectIfReceiptInFinalizedReconciliation). When a statement month's
//      amex_reconciliation row is status='finalized', every AMEX line — and
//      any receipt matched to one — is immutable. Statement-month scope.
//
//   2. Export-finalized (new below). When an export for month M is
//      status='finalized', CASH/DIGITAL receipt edits anchored by
//      transaction_date in M are blocked. A late cash receipt that arrives
//      after its transaction month shipped must go through the export
//      revision flow (POST /api/receipts/export/<month>?correction=true)
//      instead of being inserted/edited directly. Transaction-month scope.
//
// AMEX-path receipts are intentionally NOT gated by the export lock —
// they are governed by (1) via their statement line. CASH/DIGITAL
// receipts are NOT gated by (1) — they have no statement line to match.
// Each lock owns its own population; the two never overlap.

/**
 * Typed error thrown when an insert/update would land a CASH/DIGITAL
 * receipt in a month that already has a finalized export. Routes catch
 * this with `instanceof ExportFinalizedError` instead of brittle string
 * matching against error.message.
 */
export class ExportFinalizedError extends Error {
  constructor(
    /** The YYYY-MM transaction month that is locked. */
    public readonly month: string,
    message: string,
  ) {
    super(message);
    this.name = "ExportFinalizedError";
  }
}

/**
 * True when an export for `month` exists at status='finalized'. No data
 * from the row is returned — callers only need the boolean.
 */
export async function isMonthExportFinalized(month: string): Promise<boolean> {
  const db = getReceiptsDb();
  const row = await db
    .prepare(
      `SELECT 1 FROM receipt_exports
       WHERE export_month = ? AND status = 'finalized'
       LIMIT 1`,
    )
    .bind(month)
    .first<{ "1": number }>();
  return row !== null;
}

/**
 * Assert that a CASH/DIGITAL receipt can be placed in the given
 * transaction month. Throws ExportFinalizedError when month M has a
 * finalized export. Caller must format `transactionMonth` as YYYY-MM
 * (the same format receipt_records.transaction_date stores as YYYY-MM-DD).
 *
 * No-op when `transactionMonth` is null/empty — the lock can't apply
 * until the transaction_date is known (uploads insert with null date
 * and let the extraction backfill it).
 */
export async function assertTransactionMonthEditable(
  transactionMonth: string | null | undefined,
): Promise<void> {
  if (!transactionMonth) return;
  if (finalizedMemo.has(transactionMonth)) return; // memoized in-process
  const finalizedFlag = await isMonthExportFinalized(transactionMonth);
  if (finalizedFlag) {
    finalizedMemo.add(transactionMonth);
    throw new ExportFinalizedError(
      transactionMonth,
      `Month ${transactionMonth} is export-finalized. POST /api/receipts/export/${transactionMonth}?correction=true to create a revision.`,
    );
  }
}

/**
 * Derive the YYYY-MM month key from a YYYY-MM-DD transaction_date. Returns
 * null for null/empty/malformed input so callers can pass the raw column
 * value through without conditional branches.
 */
export function transactionMonthOf(
  transactionDate: string | null | undefined,
): string | null {
  if (!transactionDate) return null;
  const m = /^(\d{4}-\d{2})/.exec(transactionDate);
  return m ? m[1]! : null;
}

// In-process memo of finalized months. A single request rarely checks the
// same month more than once, but updateReceiptRecord runs the check on
// every PATCH and the same month is common within a finalize-then-edit
// race window. Cleared per Worker invocation (module-level state).
const finalizedMemo = new Set<string>();
