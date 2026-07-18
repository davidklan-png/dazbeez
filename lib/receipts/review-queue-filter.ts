// Shared review-queue helpers (review/page.tsx + [id]/page.tsx), extracted so
// the two pages cannot drift and so the lock-split / month-scope logic is
// unit-testable without importing a Next page module. Pure: no D1, no Next.

import { currentCalendarMonth } from "@/lib/receipts/month-lock";
import type { ReceiptRecord } from "@/lib/receipts/types";

export type ReviewMonthParam = string | undefined;

/** Resolve the raw `month` search param into a listReceiptRecords month scope.
 *
 *  - 'all' → no month scope (RECEIPT_VIEW_LIMIT most recent), undated not
 *    specially included.
 *  - a valid YYYY-MM → that month scope, with undated receipts OR'd in (they
 *    are usually pending extraction — the ones most needing review).
 *  - absent or malformed → default to the current calendar month (with
 *    undated included). Malformed values are ignored per spec.
 */
export function resolveReviewMonthScope(rawMonth: ReviewMonthParam): {
  month: string | undefined;
  includeUndated: boolean;
} {
  if (rawMonth === "all") return { month: undefined, includeUndated: false };
  if (rawMonth && /^\d{4}-\d{2}$/.test(rawMonth)) {
    return { month: rawMonth, includeUndated: true };
  }
  return { month: currentCalendarMonth(), includeUndated: true };
}

/** Apply the lock split + status/payment_path deep-links + workflow filter to a
 *  month-scoped working set. Locked receipts are hidden unless `filter` is
 *  'locked'. The lock map is { locked: boolean }-shaped so this stays decoupled
 *  from the full ReceiptLockInfo type. */
export function filterReviewQueue(
  receipts: ReceiptRecord[],
  filter: string,
  opts: {
    statusFilter?: string;
    paymentPathFilter?: string;
    locks: ReadonlyMap<string, { locked?: boolean }>;
  },
): ReceiptRecord[] {
  const { statusFilter, paymentPathFilter, locks } = opts;
  let queue =
    filter === "locked"
      ? receipts.filter((r) => locks.get(r.id)?.locked === true)
      : receipts.filter((r) => locks.get(r.id)?.locked !== true);

  if (statusFilter) {
    queue = queue.filter((r) => r.status === statusFilter);
  }
  if (paymentPathFilter) {
    queue = queue.filter((r) => r.payment_path === paymentPathFilter);
  }

  if (filter === "reviewed") {
    return queue.filter((r) => r.status === "reviewed");
  }
  if (filter === "needs") {
    return queue.filter(
      (r) => r.status === "needs_review" || r.status === "captured",
    );
  }
  if (filter === "attendees" || filter === "purpose") {
    return queue.filter(
      (r) =>
        (r.status === "needs_review" || r.status === "captured") &&
        !r.business_purpose,
    );
  }
  return queue;
}

/** The effective month label/value for the SubHeader + picker: 'all', or the
 *  month scope (current calendar month when on the default / no param). */
export function effectiveReviewMonth(
  monthParam: string,
  monthScope: string | undefined,
): string {
  return monthParam === "all" ? "all" : (monthScope ?? currentCalendarMonth());
}

/** Preserve the current view's params across j/k + next/prev navigation so the
 *  operator stays within the chosen month/filter view. monthParam '' (default)
 *  is omitted so default-view navigation stays on the default month. */
export function buildReviewQueryParams(
  params: Record<string, string | string[] | undefined>,
  monthParam: string,
): string {
  const sp = new URLSearchParams();
  const filter = typeof params.filter === "string" ? params.filter : undefined;
  const status = typeof params.status === "string" ? params.status : undefined;
  const paymentPath =
    typeof params.payment_path === "string" ? params.payment_path : undefined;
  if (filter) sp.set("filter", filter);
  if (monthParam) sp.set("month", monthParam);
  if (status) sp.set("status", status);
  if (paymentPath) sp.set("payment_path", paymentPath);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/** Guarantee the current month is selectable in the picker even when no
 *  receipts have landed in it yet. */
export function ensureCurrentMonth(
  months: string[],
  effectiveMonth: string,
): string[] {
  if (effectiveMonth === "all") return months;
  return months.includes(effectiveMonth) ? months : [effectiveMonth, ...months];
}
