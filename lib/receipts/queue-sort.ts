// Pure sort + search for the review queue. Extracted from the queue-controls
// React component so the comparator + matcher are unit-testable without a DOM
// or React (see tests/receipts/queue-sort.test.ts). The review working set for
// a single month never exceeds RECEIPT_VIEW_LIMIT (200), so in-memory sort and
// search are complete and instant — the hybrid boundary is the month/lock
// predicate (server), not these.

import type { QueueItem } from "@/lib/receipts/queue-items";

export type SortKey =
  | "needs"
  | "date-desc"
  | "date-asc"
  | "amount-desc"
  | "merchant-az";

/** "Needs first" preserves today's triage feel as the default: needs /
 *  stuck / failed items surface before reviewed ones. */
export const DEFAULT_SORT: SortKey = "needs";

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "needs", label: "Needs first" },
  { value: "date-desc", label: "Date ↓" },
  { value: "date-asc", label: "Date ↑" },
  { value: "amount-desc", label: "Amount ↓" },
  { value: "merchant-az", label: "Merchant A–Z" },
];

/** True for "Needs first" partitioning: the row carries an attention badge,
 *  is stuck pending, or failed extraction. Shared by the comparator + tests. */
export function needsFirst(item: QueueItem): boolean {
  return item.needs !== null || item.stuck || item.extractionFailed;
}

/** Filter the in-memory queue by a text query: merchant (substring),
 *  category label (substring), and amount — the digits typed must appear in
 *  the amount label's digits, so "1200" matches "¥1,200". Empty query returns
 *  the list unchanged. Case-insensitive on the text fields. Pure. */
export function searchQueueItems(items: QueueItem[], query: string): QueueItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const digits = q.replace(/\D/g, "");
  return items.filter((it) => {
    if (it.merchant.toLowerCase().includes(q)) return true;
    if (it.categoryLabel.toLowerCase().includes(q)) return true;
    if (digits) {
      const amountDigits = it.amountLabel.replace(/\D/g, "");
      if (amountDigits.includes(digits)) return true;
    }
    return false;
  });
}

/** Sort the queue. Pure — does not mutate the input. "Needs first" partitions
 *  by {@link needsFirst} then sorts each group date-desc. */
export function sortQueueItems(items: QueueItem[], sortKey: SortKey): QueueItem[] {
  const copy = items.slice();
  switch (sortKey) {
    case "date-desc":
      copy.sort((a, b) => b.sortDateMs - a.sortDateMs);
      break;
    case "date-asc":
      copy.sort((a, b) => a.sortDateMs - b.sortDateMs);
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
        return b.sortDateMs - a.sortDateMs; // date desc within each group
      });
      break;
  }
  return copy;
}
