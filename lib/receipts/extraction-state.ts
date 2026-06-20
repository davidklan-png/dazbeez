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
