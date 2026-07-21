// Honest orphan classification for the Reconcile screen.
//
// The matcher's ±5-day padded window (deriveStatementWindow) is unchanged — it
// stays the CANDIDATE pool so leading/trailing slack can still surface a match.
// But for DISPLAY, an unmatched receipt is not honestly "an orphan" just because
// it falls inside the padded window. Partition unmatched receipts against the
// statement's ACTUAL line MIN/MAX transaction dates:
//
//   • true_in_period  — date within [min, max]. The only population counted and
//                        labeled "Orphan receipts" (a real charge in this cycle
//                        with no matching line).
//   • leading_slack   — date before min but inside the leading pad. Belongs to
//                        the PRIOR cycle; not a true orphan of this month.
//   • upcoming        — date after max (or no statement dates at all). Awaiting
//                        the NEXT statement; labeled "Awaiting next statement".
//   • undated         — transaction_date is NULL. A separate "Needs date"
//                        population; must not repeat as an orphan every month.
//
// Pure + client-safe (type-only import) so boundaries and the empty-line
// fallback are unit-tested without D1.

/** Structural minimum the classifier reads. Works for ReceiptRecord and fixtures. */
export interface DateCarrying {
  transaction_date: string | null;
}

/** The four honest display classes for an unmatched receipt. */
export type OrphanClass =
  | "true_in_period"
  | "leading_slack"
  | "upcoming"
  | "undated";

/** Actual (un-padded) min/max transaction dates of a statement's lines.
 *  Both null when the statement has no dated lines (empty-line fallback). */
export interface StatementDateRange {
  minDate: string | null;
  maxDate: string | null;
}

/**
 * Compute the un-padded MIN/MAX transaction-date range from a statement's line
 * dates. Null entries (undated lines) are ignored. Returns {null,null} when no
 * line carries a date — the empty-line fallback signal.
 */
export function statementLineDateRange(
  lineDates: Array<string | null | undefined>,
): StatementDateRange {
  const sorted = lineDates
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .slice()
    .sort();
  if (sorted.length === 0) return { minDate: null, maxDate: null };
  return { minDate: sorted[0]!, maxDate: sorted[sorted.length - 1]! };
}

/**
 * Classify a single unmatched receipt. ISO YYYY-MM-DD strings compare lexically
 * in date order, so simple string comparisons are correct.
 *
 * Empty-line fallback (minDate/maxDate null): without statement dates there is
 * no cycle to be "in", so every dated receipt is "upcoming" (awaiting the
 * statement) and undated receipts are "undated".
 */
export function classifyUnmatchedReceipt<R extends DateCarrying>(
  receipt: R,
  range: StatementDateRange,
): OrphanClass {
  if (!receipt.transaction_date) return "undated";
  const { minDate, maxDate } = range;
  if (!minDate || !maxDate) return "upcoming";
  const d = receipt.transaction_date;
  // Inclusive on both ends: a charge on the first or last line date is in-period.
  if (d < minDate) return "leading_slack";
  if (d > maxDate) return "upcoming";
  return "true_in_period";
}

export interface OrphanPartition<R extends DateCarrying> {
  /** The ONLY population that counts as "Orphan receipts". */
  true_in_period: R[];
  /** Date before the cycle (in the leading pad) — prior-cycle, not an orphan. */
  leading_slack: R[];
  /** Date after the cycle, or no statement dates — "Awaiting next statement". */
  upcoming: R[];
  /** No transaction_date — "Needs date"; must not repeat as an orphan monthly. */
  undated: R[];
}

/** Partition unmatched receipts into the four display classes. Pure. */
export function partitionUnmatchedReceipts<R extends DateCarrying>(
  receipts: R[],
  range: StatementDateRange,
): OrphanPartition<R> {
  const out: OrphanPartition<R> = {
    true_in_period: [],
    leading_slack: [],
    upcoming: [],
    undated: [],
  };
  for (const r of receipts) {
    out[classifyUnmatchedReceipt(r, range)].push(r);
  }
  return out;
}
