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

// ─── Split lock model (audit A5, fix F1-F3 2026-07-08) ───────────────────────
//
// Two independent locks govern month-end state, each blocking a different
// kind of edit:
//
//   1. Reconciliation-sealed (existing, in db.ts
//      rejectIfReceiptInFinalizedReconciliation). When a statement month's
//      amex_reconciliation row is status='finalized', every AMEX line — and
//      any receipt matched to one — is immutable. Statement-month scope.
//
//   2. Export-finalized (below). When an export for month M is
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
//
// F1 correction (2026-07-08 architecture review): the lock must release
// while a draft revision exists for the month. A finalized export row is
// permanent (preservation principle), so without this carve-out the
// correction flow could never actually correct anything — every edit
// attempt would re-hit the finalized row and re-throw. The predicate
// below treats "has draft revision" as a release of the lock; finalizing
// the revision closes the lock again (draft goes away, finalized stays).
//
// ADR 0012 (2026-07-20) unifies this draft carve-out as the single "month
// open for correction" signal across ALL three edit gates: this export lock
// (#1), the reconciliation lock (#2, for receipt edits only —
// rejectIfReceiptInFinalizedReconciliation in db.ts), and the per-receipt
// status gate (#3 — an `exported` receipt becomes editable/deletable while a
// draft is open, via isMonthLockedForEdits in the PATCH/DELETE paths). The
// line-level reconciliation seal (rejectIfFinalized on amex_statement_lines
// writes) deliberately stays strict. See receipt-locks.ts header +
// docs/adr/0012-unified-draft-carveout-month-locks.md.

/**
 * Typed error thrown when an insert/update would land a CASH/DIGITAL
 * receipt in a month that already has a finalized export and no open
 * draft revision. Routes catch this with `instanceof ExportFinalizedError`
 * instead of brittle string matching against error.message.
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
 * Minimal D1 shape this module queries against. Exported so tests can
 * build a fake without depending on the full Cloudflare D1Database type.
 */
export interface MonthLockD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

/**
 * True when an export for `month` exists at status='finalized'. No data
 * from the row is returned — callers only need the boolean.
 *
 * Note: this does NOT account for draft revisions. For "is this month
 * locked for edits?" use {@link isMonthLockedForEdits} instead — that
 * predicate releases the lock while a draft revision exists.
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
 * The actual edit-lock predicate. A month is locked for CASH/DIGITAL
 * receipt edits iff:
 *   - an export exists at status='finalized' for the month, AND
 *   - no export exists at status='draft' for the month.
 *
 * The draft carve-out is what makes the correction flow workable: opening
 * a revision via POST /api/receipts/export/<month>?correction=true creates
 * a fresh draft row, which releases the lock for the duration of the
 * correction. Finalizing the revision (or deleting the draft) re-closes
 * it. One indexed D1 lookup per mutation — acceptable cost, and avoids
 * the stale-cache trap a module-level memo would introduce (F2).
 *
 * Takes `db` as a parameter so tests can fake it without module mocking.
 */
export async function isMonthLockedForEdits(
  db: MonthLockD1,
  month: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT CASE
         WHEN EXISTS(
           SELECT 1 FROM receipt_exports
           WHERE export_month = ? AND status = 'draft'
         ) THEN 0
         WHEN EXISTS(
           SELECT 1 FROM receipt_exports
           WHERE export_month = ? AND status = 'finalized'
         ) THEN 1
         ELSE 0
       END AS locked`,
    )
    .bind(month, month)
    .first<{ locked: 0 | 1 }>();
  return row?.locked === 1;
}

/**
 * Assert that a CASH/DIGITAL receipt can be placed in the given
 * transaction month. Throws ExportFinalizedError when the month is locked
 * for edits (see {@link isMonthLockedForEdits}). Caller must format
 * `transactionMonth` as YYYY-MM (the same format
 * receipt_records.transaction_date stores as YYYY-MM-DD).
 *
 * No-op when `transactionMonth` is null/empty — the lock can't apply
 * until the transaction_date is known (uploads insert with null date
 * and let the extraction backfill it).
 */
export async function assertTransactionMonthEditable(
  transactionMonth: string | null | undefined,
): Promise<void> {
  if (!transactionMonth) return;
  const db = getReceiptsDb();
  if (await isMonthLockedForEdits(db, transactionMonth)) {
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

/**
 * The YYYY-MM of "now" in the operator's timezone (JST, UTC+9). Used as the
 * review queue's default month scope. JST-aware so a capture late on the 1st
 * (or early-UTC on the 1st = still the 1st in Tokyo) isn't off-by-one against
 * a UTC `toISOString()` slice.
 */
export function currentCalendarMonth(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 7);
}
