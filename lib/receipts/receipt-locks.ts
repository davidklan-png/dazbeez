// Review-queue lock surface (three-gate model with a unified draft carve-out,
// ADR 0012; see also month-lock.ts header + audit A5).
//
// The review queue hides receipts the server would refuse to mutate, so the
// operator never types into a locked receipt and discovers the 409 at save
// time. The server enforces THREE independent gates; this module mirrors the
// first two for display (gate #3 is a per-receipt status check the queue
// infers from `status`):
//
//   1. EXPORT lock — a non-AMEX receipt (CASH/DIGITAL/UNKNOWN) whose
//      transaction month is export-sealed: status='finalized' export exists
//      AND no 'draft' revision (loadSealedExportMonths). AMEX is intentionally
//      NOT export-gated — it flows through (2).
//   2. RECONCILIATION lock — an AMEX/UNKNOWN receipt matched to an
//      amex_statement_lines row whose statement month's
//      amex_reconciliation.status='finalized'. CASH/DIGITAL have no statement
//      line to match, so they are not recon-gated.
//   3. PER-RECEIPT STATUS gate (server only — PATCH app/api/receipts/[id]/
//      route.ts + softDeleteReceipt in db.ts): status='exported'/'archived'
//      is refused, except 'exported' is released under the carve-out below.
//
// Unified draft carve-out (ADR 0012): an open export draft
// (receipt_exports.status='draft') for a month is the SINGLE "month open for
// correction" signal. It releases gate #1 (by definition), gate #2 for RECEIPT
// edits only (loadReconciliationLockedReceiptIds excludes draft months; the
// server's rejectIfReceiptInFinalizedReconciliation does the same), and gate #3
// (isMonthLockedForEdits → false). The LINE-level reconciliation seal
// (rejectIfFinalized on amex_statement_lines writes) is deliberately NOT
// released — a format-only export revision must not reopen match assignments.
//
// Undated receipts are never EXPORT-locked (transactionMonthOf → null). They
// may still be RECONCILIATION-locked when matched to a finalized line (subject
// to the carve-out).
//
// This module is read-only: it computes lock info for display. It does NOT
// enforce anything — the API-side 409 backstop stays the source of truth.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { loadSealedExportMonths } from "@/lib/receipts/membership";
import { transactionMonthOf } from "@/lib/receipts/month-lock";
import { D1_ID_CHUNK_SIZE } from "@/lib/receipts/db-utils";
import type { PaymentPath, ReceiptRecord } from "@/lib/receipts/types";

export type ReceiptLockKind = "export" | "reconciliation";

export type ReceiptLockInfo = {
  locked: boolean;
  kind: ReceiptLockKind | null;
  /** The sealed YYYY-MM driving the lock (transaction month for export,
   *  statement month for reconciliation). null when unlocked. */
  month: string | null;
};

/** Shared unlocked singleton — the common case, so the queue Map stays small. */
export const UNLOCKED_RECEIPT: ReceiptLockInfo = {
  locked: false,
  kind: null,
  month: null,
};

/**
 * Minimal D1 shape this module queries against. Exported so tests can build a
 * fake without depending on the full Cloudflare D1Database type (same pattern
 * as MonthLockD1 in month-lock.ts, but with `.all()` for the set-returning
 * reconciliation query).
 */
export interface ReceiptLockD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

/**
 * Pure lock computation. Exported so the lock matrix is unit-testable without
 * any D1 fake: feed the two query results (sealed export months + the receipt
 * ids matched to a finalized reconciliation, each with its statement month)
 * and this returns the per-receipt lock info. All I/O is factored into
 * {@link getReceiptLocks} below.
 */
export function computeReceiptLocks(
  receipts: ReceiptRecord[],
  sealedExportMonths: ReadonlySet<string>,
  reconLockedByReceiptId: ReadonlyMap<string, string>,
): Map<string, ReceiptLockInfo> {
  const out = new Map<string, ReceiptLockInfo>();
  for (const r of receipts) {
    // Reconciliation side first (more specific): AMEX/UNKNOWN matched to a
    // finalized statement line.
    if (isAmexLikeForLock(r.payment_path) && reconLockedByReceiptId.has(r.id)) {
      out.set(r.id, {
        locked: true,
        kind: "reconciliation",
        month: reconLockedByReceiptId.get(r.id) ?? null,
      });
      continue;
    }
    // Export side: non-AMEX receipt whose transaction month is sealed.
    if (r.payment_path !== "AMEX") {
      const m = transactionMonthOf(r.transaction_date);
      if (m && sealedExportMonths.has(m)) {
        out.set(r.id, { locked: true, kind: "export", month: m });
        continue;
      }
    }
    out.set(r.id, UNLOCKED_RECEIPT);
  }
  return out;
}

/** AMEX is always recon-gated. UNKNOWN is included so a not-yet-classified
 *  receipt that is nonetheless matched to a finalized AMEX line shows locked
 *  (the server recon predicate is path-agnostic — see module header). */
function isAmexLikeForLock(paymentPath: PaymentPath): boolean {
  return paymentPath === "AMEX" || paymentPath === "UNKNOWN";
}

/**
 * Load, in one query, the receipt ids matched to any finalized reconciliation
 * line, keyed by receipt id → statement month. Mirrors the join in
 * rejectIfReceiptInFinalizedReconciliation (db.ts) but set-returning over the
 * passed ids instead of one query per receipt. A receipt may match several
 * lines in the same finalized month; first writer wins (the month is identical
 * across them). Takes `db` so tests can fake it.
 */
export async function loadReconciliationLockedReceiptIds(
  db: ReceiptLockD1,
  receiptIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (receiptIds.length === 0) return out;
  // Chunk over D1_ID_CHUNK_SIZE: the review queue passes every receipt id (100+
  // for an all-months view), and D1 rejects more than 100 bound params per
  // statement. First-writer-wins is preserved across chunks (a receipt matching
  // several lines in the same finalized month yields the same month anyway).
  for (let i = 0; i < receiptIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = receiptIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await db
      .prepare(
        `SELECT asl.matched_receipt_id AS rid, ar.statement_month AS m
         FROM amex_statement_lines AS asl
         JOIN amex_reconciliations AS ar
           ON ar.statement_month = asl.statement_month
          AND ar.status = 'finalized'
         WHERE asl.matched_receipt_id IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM receipt_exports re
             WHERE re.export_month = ar.statement_month
               AND re.status = 'draft'
           )`,
      )
      .bind(...chunk)
      .all<{ rid: string; m: string }>();
    for (const row of res.results ?? []) {
      if (!out.has(row.rid)) out.set(row.rid, row.m);
    }
  }
  return out;
}

/**
 * Compute lock info for a set of receipts. Two queries total regardless of N:
 * one {@link loadSealedExportMonths} call (cached-where-appropriate upstream)
 * and one set-returning reconciliation query. Returns a Map keyed by receipt id
 * covering every input receipt (unlocked ones included, so callers can do a
 * single `.get(id)` lookup without a default).
 */
export async function getReceiptLocks(
  receipts: ReceiptRecord[],
): Promise<Map<string, ReceiptLockInfo>> {
  if (receipts.length === 0) return new Map();
  const sealedExportMonths = await loadSealedExportMonths();
  const reconLocked = await loadReconciliationLockedReceiptIds(
    getReceiptsDb(),
    receipts.map((r) => r.id),
  );
  return computeReceiptLocks(receipts, sealedExportMonths, reconLocked);
}
