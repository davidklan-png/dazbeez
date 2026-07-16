// Receipt list-query limit policy. Client-safe and dependency-free: no
// server-only, runtime-binding, React, or Next.js imports. The constants below
// are the policy authority for bounded receipt reads — they are not a config
// object, env override, parsing helper, or clamp function.

/**
 * Maximum bounded receipt set used by operator-facing views (capture, review,
 * reconcile) and the receipt-list API clamp. These views fetch a finite working
 * set and do not claim exhaustive retrieval.
 */
export const RECEIPT_VIEW_LIMIT = 200;

/**
 * Broader safety ceiling used for current-month dashboard aggregation and
 * pending-extraction checks. It is intentionally larger than the view limit,
 * but it is NOT an exhaustive export/compliance primitive — exhaustive month
 * reads must continue using `listAllReceiptsInMonth`.
 */
export const RECEIPT_BULK_LIMIT = 1000;

/**
 * True when a bounded pending-result count exceeds RECEIPT_BULK_LIMIT. Callers
 * that fetch `RECEIPT_BULK_LIMIT + 1` rows can use this helper to distinguish a
 * complete bounded result (at most RECEIPT_BULK_LIMIT) from an overflow
 * sentinel indicating the backlog is deeper than the safety ceiling.
 *
 * This consumes an internal array length — it does not parse or validate input.
 */
export function hasReceiptBulkOverflow(resultCount: number): boolean {
  return resultCount > RECEIPT_BULK_LIMIT;
}
