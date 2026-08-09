// Pending-processing helpers (ADR 0001).
//
// A captured receipt sits in the extraction queue until the Mac MLX consumer
// processes it. Until then it has no merchant/amount/date key and cannot be
// matched to an AMEX line — so it is NOT a "missing receipt", it is "pending
// processing". This is a first-class state the review/reconcile UI and the
// month-close gate must reason about, per ADR 0001.

import { PENDING_EXTRACTION_STATES, type ReceiptRecord } from "@/lib/receipts/types";

/**
 * True if the receipt is captured but not yet processed by the model.
 *
 * Prefers the explicit `extraction_state`; falls back to `status === 'captured'`
 * for rows written before 0016 / by clients that don't set the column.
 */
export function isPendingProcessing(receipt: ReceiptRecord): boolean {
  if (receipt.extraction_state) {
    return PENDING_EXTRACTION_STATES.includes(receipt.extraction_state);
  }
  return receipt.status === "captured";
}

/** Receipts still waiting on the model. */
export function pendingProcessingReceipts(receipts: ReceiptRecord[]): ReceiptRecord[] {
  return receipts.filter(isPendingProcessing);
}

// ─── Processor health ─────────────────────────────────────────────────────
//
// MOVED to lib/receipts/pipeline-health.ts (getPipelineHealth). The old
// getExtractionHealth was row-based, covered only ~class 2 (consumer stall),
// and — because it built on pendingProcessingReceipts, which excludes
// needs_render — could not see render-leg stalls. Superseded 2026-08-09 by a
// cheap 4-class surface (backlog #19); this module now keeps only the
// pending-state predicates (isPendingProcessing / pendingProcessingReceipts).
