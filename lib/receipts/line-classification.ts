// Source-of-truth resolver for AMEX line classification.
//
// When an AMEX statement line has a matched receipt, the receipt's
// expense_category_code is authoritative — the line is a no-op display
// surface for classification (the reconcile UI shows the receipt's category
// read-only and hides the line-level dropdown in this state). For
// no-receipt lines (and dangling matches where the receipt was deleted),
// the line's own category is the only source.
//
// This does NOT migrate or clear line.expense_category_code values. It only
// changes what validators and the manifest read.

import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

export function resolveLineCategory(
  line: Pick<AmexStatementLine, "matched_receipt_id" | "expense_category_code">,
  receipt: Pick<ReceiptRecord, "expense_category_code" | "deleted_at"> | undefined | null,
): string | null {
  // Matched receipt that exists and is not soft-deleted → receipt wins.
  if (receipt && !receipt.deleted_at) {
    return receipt.expense_category_code ?? null;
  }
  // No receipt, dangling match (id set but receipt not in our map), or
  // soft-deleted receipt → fall back to the line's own value.
  return line.expense_category_code ?? null;
}
