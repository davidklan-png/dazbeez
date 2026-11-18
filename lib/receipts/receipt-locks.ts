// Read-only Review display of canonical receipt edit locks (server + 0043).
// Correction drafts release only their own month's claims. Line-level seals
// stay strict; this module neither enforces mutations nor changes queue scope.
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { loadSealedExportMonths } from "@/lib/receipts/membership";
import { monthLockedForEditsSql, transactionMonthOf } from "@/lib/receipts/month-lock";
import { D1_ID_CHUNK_SIZE } from "@/lib/receipts/db-utils";
import type { ReceiptRecord } from "@/lib/receipts/types";

export type ReceiptLockKind = "export" | "reconciliation" | "archived" | "exported";

export type ReceiptLockInfo = {
  locked: boolean;
  kind: ReceiptLockKind | null;
  /** Concrete locking month, or null for a terminal status without a month. */
  month: string | null;
};

export const UNLOCKED_RECEIPT: ReceiptLockInfo = {
  locked: false,
  kind: null,
  month: null,
};

export interface ReceiptLockD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

export function computeReceiptLocks(
  receipts: ReceiptRecord[],
  sealedExportMonths: ReadonlySet<string>,
  claimLocks: ReadonlyMap<string, ReceiptLockInfo>,
): Map<string, ReceiptLockInfo> {
  return new Map(receipts.map((r) => {
    let lock = claimLocks.get(r.id) ?? UNLOCKED_RECEIPT;
    if (r.status === "archived") {
      lock = { locked: true, kind: "archived", month: r.exported_month ?? null };
    } else if (!lock.locked) {
      // Exported claims are path/status independent, including pre-item rows.
      // Sticky membership is authoritative for CASH/DIGITAL (0043).
      const months = [
        r.exported_month,
        ...(r.payment_path === "CASH" || r.payment_path === "DIGITAL"
          ? [r.export_statement_month] : []),
        // Preserve the existing UNKNOWN calendar-month display policy.
        ...(r.payment_path !== "AMEX" ? [transactionMonthOf(r.transaction_date)] : []),
      ];
      const month = months.find((m) => m && sealedExportMonths.has(m));
      if (month) lock = { locked: true, kind: "export", month };
      else if (r.status === "exported" && !r.exported_month) {
        // The PATCH status gate refuses an exported receipt without provenance.
        lock = { locked: true, kind: "exported", month: null };
      }
    }
    return [r.id, lock];
  }));
}

/** Batched, path-independent claims. Stable reason priority then oldest month
 *  chooses one concrete explanation even when several closed claims coexist. */
export async function loadReceiptClaimLocks(
  db: ReceiptLockD1,
  receiptIds: string[],
): Promise<Map<string, ReceiptLockInfo>> {
  const out = new Map<string, ReceiptLockInfo>();
  for (let i = 0; i < receiptIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = receiptIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    // Each arm binds the ids: keep the total below D1's parameter limit.
    for (const kind of ["reconciliation", "export"] as const) {
      const claims = kind === "reconciliation"
        ? `SELECT asl.matched_receipt_id AS rid, ar.statement_month AS m
           FROM amex_statement_lines asl
           JOIN amex_reconciliations ar
             ON ar.statement_month = asl.statement_month AND ar.status = 'finalized'
           WHERE asl.matched_receipt_id IN (${placeholders})
             AND ${monthLockedForEditsSql("ar.statement_month")}`
        : `SELECT i.item_id AS rid, e.export_month AS m
           FROM receipt_export_items i
           JOIN receipt_exports e ON e.id = i.export_id AND e.status = 'finalized'
           WHERE i.item_type = 'receipt' AND i.item_id IN (${placeholders})
             AND ${monthLockedForEditsSql("e.export_month")}`;
      const res = await db.prepare(`${claims} ORDER BY m ASC, rid ASC`)
        .bind(...chunk).all<{ rid: string; m: string }>();
      for (const row of res.results ?? []) {
        if (!out.has(row.rid)) out.set(row.rid, { locked: true, kind, month: row.m });
      }
    }
  }
  return out;
}

/** One month read plus two claim reads per D1-sized chunk, never per receipt. */
export async function getReceiptLocks(
  receipts: ReceiptRecord[],
  db: D1Database = getReceiptsDb(),
): Promise<Map<string, ReceiptLockInfo>> {
  if (receipts.length === 0) return new Map();
  const sealedExportMonths = await loadSealedExportMonths(db);
  const claims = await loadReceiptClaimLocks(db, receipts.map((r) => r.id));
  return computeReceiptLocks(receipts, sealedExportMonths, claims);
}
