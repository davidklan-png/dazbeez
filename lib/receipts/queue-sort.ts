// Pure sort for the review queue. Extracted from the queue-controls React
// component so the comparator is unit-testable without a DOM or React (see
// tests/receipts/queue-sort.test.ts). The review working set for a single
// month never exceeds RECEIPT_VIEW_LIMIT (200), so an in-memory sort is
// complete and instant — the hybrid boundary is the month/lock predicate
// (server), not this.
//
// The client-side search control was removed (review-closing-scope UI); the
// sort selector remains. j/k + next/prev walk the sorted list.

import type { QueueItem } from "@/lib/receipts/queue-items";

export type SortKey =
  | "needs"
  | "date-desc"
  | "date-asc"
  | "amount-desc"
  | "merchant-az";

/** Earliest transaction/capture date first — the review queue's default so the
 *  operator works through a statement month chronologically. Undated/legacy
 *  rows (sortDateMs === 0) sort LAST, not ahead of real dates. */
export const DEFAULT_SORT: SortKey = "date-asc";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "date-asc", label: "Date ↑ (earliest)" },
  { value: "date-desc", label: "Date ↓ (latest)" },
  { value: "needs", label: "Needs first" },
  { value: "amount-desc", label: "Amount ↓" },
  { value: "merchant-az", label: "Merchant A–Z" },
];

/** True for "Needs first" partitioning: the row carries a closing-attention
 *  reason (the same authority that drives the pill + "Needs review" tab), is
 *  stuck pending, or failed extraction. Shared by the comparator + tests. */
export function needsFirst(item: QueueItem): boolean {
  return item.attentionCodes.length > 0 || item.stuck || item.extractionFailed;
}

/** True when the row has no parseable date — sortDateMs is the 0 sentinel
 *  queue-items assigns to undated/legacy receipts. These sort to the end of
 *  any date ordering so real dates always come first. */
function isUndated(item: QueueItem): boolean {
  return item.sortDateMs === 0;
}

/** Date comparator with a stable "undated last" rule. `dir` selects ascending
 *  vs descending for dated rows; undated rows always sort after dated ones
 *  (and tie among themselves in input order, since sortQueueItems is stable). */
function compareByDate(a: QueueItem, b: QueueItem, dir: 1 | -1): number {
  const aU = isUndated(a);
  const bU = isUndated(b);
  if (aU && bU) return 0;
  if (aU) return 1; // a is undated → after b
  if (bU) return -1; // b is undated → a before b
  return dir === 1 ? a.sortDateMs - b.sortDateMs : b.sortDateMs - a.sortDateMs;
}

/** Sort the queue. Pure — does not mutate the input.
 *  - date-asc / date-desc: by date, undated last in both orders.
 *  - amount-desc: by amount, unknown amounts (-1) last.
 *  - merchant-az: case-insensitive.
 *  - needs: attention/stuck/failed first, each group date-desc (undated last). */
export function sortQueueItems(items: QueueItem[], sortKey: SortKey): QueueItem[] {
  const copy = items.slice();
  switch (sortKey) {
    case "date-asc":
      copy.sort((a, b) => compareByDate(a, b, 1));
      break;
    case "date-desc":
      copy.sort((a, b) => compareByDate(a, b, -1));
      break;
    case "amount-desc":
      copy.sort((a, b) => b.sortAmountMinor - a.sortAmountMinor);
      break;
    case "merchant-az":
      copy.sort((a, b) =>
        a.merchant.localeCompare(b.merchant, undefined, { sensitivity: "base" }),
      );
      break;
    case "needs":
    default:
      copy.sort((a, b) => {
        const an = needsFirst(a) ? 0 : 1;
        const bn = needsFirst(b) ? 0 : 1;
        if (an !== bn) return an - bn;
        return compareByDate(a, b, -1); // date desc within each group, undated last
      });
      break;
  }
  return copy;
}
