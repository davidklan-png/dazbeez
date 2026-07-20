// Shared review-queue helpers (review/page.tsx + [id]/page.tsx), extracted so
// the two pages cannot drift and so the lock-split / month-scope / closing-scope
// / attention logic is unit-testable without importing a Next page module.
// Pure: no D1, no Next.

import { currentCalendarMonth } from "@/lib/receipts/month-lock";
import type { ReceiptRecord } from "@/lib/receipts/types";

export type ReviewMonthParam = string | undefined;
export type ReviewScope = "calendar" | "closing";

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

/** Parse the `scope` search param. Anything other than the literal "closing"
 *  (including absent) is calendar scope — the default, backward-compatible
 *  behavior. */
export function parseReviewScope(rawScope: string | undefined): ReviewScope {
  return rawScope === "closing" ? "closing" : "calendar";
}

/** The effective scope after applying the month rule: closing scope is only
 *  meaningful for a real YYYY-MM month, so 'all' (and the default/no-param
 *  view) always resolves to calendar. Selecting 'all' must drop scope=closing. */
export function resolveReviewScope(
  rawScope: string | undefined,
  monthParam: string,
): ReviewScope {
  const scope = parseReviewScope(rawScope);
  if (scope !== "closing") return "calendar";
  // Closing requires a concrete statement month.
  return monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? "closing" : "calendar";
}

/** True when a month param value is a concrete YYYY-MM (not '' / 'all'). */
export function isConcreteMonth(monthParam: string): boolean {
  return /^\d{4}-\d{2}$/.test(monthParam);
}

/** Apply the lock split + status/payment_path deep-links + workflow filter to a
 *  working set. Locked receipts are hidden unless `filter` is 'locked'. The lock
 *  map is { locked: boolean }-shaped so this stays decoupled from the full
 *  ReceiptLockInfo type.
 *
 *  Tabs (review-closing-scope UI): All / Needs review / AMEX / Non-AMEX / Locked.
 *  - All: unlocked receipts in the working set.
 *  - Needs review: unlocked receipts whose id is in `attentionIds` (the shared
 *    closing-attention set — see lib/receipts/review-attention.ts).
 *  - AMX / Non-AMEX: partition by payment_path (calendar scope) or by membership
 *    in `amexMatchedIds` (closing scope — receipts matched to the statement's
 *    AMEX lines vs the remaining CASH/DIGITAL/UNKNOWN scope receipts).
 *  - Locked: only locked receipts.
 *  Legacy filter keys (attendees, purpose, reviewed) and any unknown key fall
 *  back to All. Legacy status/payment_path deep-link params still apply. */
export function filterReviewQueue(
  receipts: ReceiptRecord[],
  filter: string,
  opts: {
    statusFilter?: string;
    paymentPathFilter?: string;
    locks: ReadonlyMap<string, { locked?: boolean }>;
    /** Closing-attention id set — drives the Needs review tab + amber pill. */
    attentionIds?: ReadonlySet<string>;
    /** "closing" partitions AMEX/Non-AMEX by amexMatchedIds; "calendar" (the
     *  default) partitions by payment_path. */
    scope?: ReviewScope;
    /** Closing scope only: receipt ids matched to the statement's AMEX lines. */
    amexMatchedIds?: ReadonlySet<string>;
  },
): ReceiptRecord[] {
  const { statusFilter, paymentPathFilter, locks, attentionIds, scope = "calendar", amexMatchedIds } = opts;

  const isLocked = (r: ReceiptRecord) => locks.get(r.id)?.locked === true;
  let queue =
    filter === "locked"
      ? receipts.filter(isLocked)
      : receipts.filter((r) => !isLocked(r));

  // Legacy deep-link filters still apply (existing links keep working). Clicking
  // a filter tab drops them (handled in the layout's href builder).
  if (statusFilter) queue = queue.filter((r) => r.status === statusFilter);
  if (paymentPathFilter) queue = queue.filter((r) => r.payment_path === paymentPathFilter);

  const isAmexReceipt = (r: ReceiptRecord): boolean =>
    scope === "closing" && amexMatchedIds
      ? amexMatchedIds.has(r.id)
      : r.payment_path === "AMEX";

  switch (filter) {
    case "needs":
      return queue.filter((r) => attentionIds?.has(r.id) ?? false);
    case "amex":
      return queue.filter(isAmexReceipt);
    case "non-amex":
      return queue.filter((r) => !isAmexReceipt(r));
    // Legacy keys (attendees, purpose, reviewed) + unknown → All (unlocked).
    default:
      return queue;
  }
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
 *  operator stays within the chosen month/scope/filter view. monthParam ''
 *  (default) is omitted so default-view navigation stays on the default month.
 *  scope=closing is preserved only for a concrete YYYY-MM month (dropped for
 *  'all'/default, matching resolveReviewScope). */
export function buildReviewQueryParams(
  params: Record<string, string | string[] | undefined>,
  monthParam: string,
  scope: ReviewScope = "calendar",
): string {
  const sp = new URLSearchParams();
  const filter = typeof params.filter === "string" ? params.filter : undefined;
  const status = typeof params.status === "string" ? params.status : undefined;
  const paymentPath =
    typeof params.payment_path === "string" ? params.payment_path : undefined;
  if (filter) sp.set("filter", filter);
  if (monthParam) sp.set("month", monthParam);
  if (scope === "closing" && isConcreteMonth(monthParam)) sp.set("scope", "closing");
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

/** Union the month sources for the picker: distinct receipt transaction months,
 *  AMEX statement months (line-count query keys), and the effective month. All
 *  non-empty sources are deduped and sorted newest-first. Pure — callers pass
 *  the already-loaded lists. */
export function mergeMonthOptions(
  receiptMonths: string[],
  amexMonths: string[],
  effectiveMonth: string,
): string[] {
  const set = new Set<string>();
  for (const m of receiptMonths) if (m) set.add(m);
  for (const m of amexMonths) if (m) set.add(m);
  if (effectiveMonth && effectiveMonth !== "all") set.add(effectiveMonth);
  return [...set].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
