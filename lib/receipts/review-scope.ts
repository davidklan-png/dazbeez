// Closing-scope working set for the review queue.
//
// "Closing scope" for a statement month M = the receipts that ship in M's
// export bundle, i.e. the monthly-closing membership. This must be the EXACT
// same population the export/finalize path assembles, so the review queue can
// never show a different set than the one the operator is about to seal. We
// reuse buildExportBundle(M).receipts + listUnknownInScopeReceipts(M) — the
// single membership authorities — rather than re-deriving membership here.
//
// See ADR 0005 / 0008 and lib/receipts/month-closing.ts (buildExportBundle) for
// the composition rules. This module adds only: dedupe by receipt id, and the
// AMEX-tab partition (the ids matched to M's statement lines) the filter needs.

import { buildExportBundle } from "@/lib/receipts/month-closing";
import { listUnknownInScopeReceipts } from "@/lib/receipts/membership";
import type { ReceiptRecord } from "@/lib/receipts/types";

export interface ClosingScopeWorkingSet {
  /** Deduped closing-membership receipts for the month (matched AMEX +
   *  CASH/DIGITAL assigned to M + UNKNOWN receipts in M's calendar month). */
  receipts: ReceiptRecord[];
  /** Receipt ids matched to this statement month's AMEX lines — the AMEX-tab
   *  partition in closing scope (the rest are Non-AMEX). */
  amexMatchedIds: Set<string>;
}

/**
 * Load the closing-scope working set for statement month M. Membership =
 * buildExportBundle(M).receipts ∪ listUnknownInScopeReceipts(M), deduped by id.
 *
 *   - AMEX receipts matched to M's statement lines are included even when their
 *     transaction_date falls in another calendar month (the whole reason the
 *     bundle exists — statement windows lag the statement label).
 *   - CASH/DIGITAL receipts assigned to M via export_statement_month are
 *     included (buildExportBundle selects them).
 *   - UNKNOWN receipts whose transaction_date's calendar month is M are included
 *     (listUnknownInScopeReceipts).
 *   - An AMEX receipt is NOT included merely because its transaction_date is in
 *     M — only if it is matched to one of M's lines.
 */
export async function loadClosingScopeWorkingSet(
  month: string,
): Promise<ClosingScopeWorkingSet> {
  const [bundle, unknown] = await Promise.all([
    buildExportBundle(month),
    listUnknownInScopeReceipts(month),
  ]);

  const seen = new Set<string>();
  const receipts: ReceiptRecord[] = [];
  for (const r of [...bundle.receipts, ...unknown]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    receipts.push(r);
  }

  const amexMatchedIds = new Set<string>();
  for (const line of bundle.amexLines) {
    if (line.matched_receipt_id) amexMatchedIds.add(line.matched_receipt_id);
  }

  return { receipts, amexMatchedIds };
}
