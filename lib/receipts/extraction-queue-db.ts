// Extraction-queue data access for receipt_records.
//
// The pending extraction_state mirror (captured / queued / processing) is its
// own small domain: a list query (the month-close gate's "is the queue empty?"
// check) and an idempotent reconcile update (ADR 0001 poison-pill handling).
// Extracted from lib/receipts/db.ts so the pending-state filter has a single
// source (PENDING_EXTRACTION_STATES) instead of two raw SQL literals.
//
// Re-exported from lib/receipts/db.ts; existing callers are unchanged.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { nowIso } from "@/lib/receipts/db-utils";
import { PENDING_EXTRACTION_STATES } from "@/lib/receipts/types";
import type { ReceiptRecord } from "@/lib/receipts/types";

// One bind placeholder per pending state, e.g. "?, ?, ?". Derived from the
// typed constant so the SQL and the bindings cannot drift apart.
const PENDING_STATE_PLACEHOLDERS = PENDING_EXTRACTION_STATES.map(
  () => "?",
).join(", ");

/** Terminal states a pending extraction_state may be reconciled to. */
export type TerminalExtractionState = "processed" | "failed";

/**
 * Pure spec for the pending-processing list query. Bindings are in D1 bind
 * order: the pending states first (the IN clause precedes LIMIT in the SQL),
 * then the limit.
 *
 * [...PENDING_EXTRACTION_STATES, limit]
 */
export function buildPendingProcessingQuery(limit = 1000): {
  sql: string;
  bindings: readonly unknown[];
} {
  const sql = `SELECT * FROM receipt_records
     WHERE deleted_at IS NULL
       AND extraction_state IN (${PENDING_STATE_PLACEHOLDERS})
     ORDER BY captured_at DESC LIMIT ?`;
  return { sql, bindings: [...PENDING_EXTRACTION_STATES, limit] };
}

/**
 * Pure spec for the idempotent extraction_state reconcile update. Bindings are
 * in D1 bind order: the SET columns, then the id, then the pending states that
 * gate the WHERE clause.
 *
 * [finalState, now, now, id, ...PENDING_EXTRACTION_STATES]
 */
export function buildReconcileExtractionStateQuery(
  id: string,
  finalState: TerminalExtractionState,
  now: string,
): { sql: string; bindings: readonly unknown[] } {
  const sql = `UPDATE receipt_records
       SET extraction_state = ?, extraction_processed_at = ?, updated_at = ?
     WHERE id = ?
       AND extraction_state IN (${PENDING_STATE_PLACEHOLDERS})`;
  return { sql, bindings: [finalState, now, now, id, ...PENDING_EXTRACTION_STATES] };
}

/**
 * List receipts still in a pending extraction_state (ADR 0001). The month-close
 * gate relies on this being exhaustive over captured/queued/processing.
 * Default limit 1000.
 */
export async function listPendingProcessingReceipts(
  limit = 1000,
): Promise<ReceiptRecord[]> {
  const db = getReceiptsDb();
  const { sql, bindings } = buildPendingProcessingQuery(limit);
  const result = await db.prepare(sql).bind(...bindings).all<ReceiptRecord>();
  return result.results ?? [];
}

/**
 * Reconcile a stale pending extraction_state to a terminal one (ADR 0001).
 * Idempotent: only touches rows still in a pending state, so it is safe to call
 * defensively. Used by the extract route when a queued message arrives for a
 * receipt that can no longer be extracted (already reviewed → 'processed') or
 * whose image was unreadable (→ 'failed'), so the consumer can ack the poison
 * pill without leaving the month-close gate blocked. Deliberately bypasses the
 * finalized-reconciliation guard — this only fixes the queue-state mirror, it
 * does not touch business fields.
 */
export async function reconcileExtractionState(
  id: string,
  finalState: TerminalExtractionState,
): Promise<void> {
  const db = getReceiptsDb();
  const { sql, bindings } = buildReconcileExtractionStateQuery(
    id,
    finalState,
    nowIso(),
  );
  await db.prepare(sql).bind(...bindings).run();
}
