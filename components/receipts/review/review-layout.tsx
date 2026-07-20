"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReactNode } from "react";
import { Pill } from "@/components/ui/pill";
import { LockIcon } from "@/components/ui/icons";
import { KeyboardHintBar } from "@/components/receipts/ui/keyboard-hint-bar";
import { QueueRail } from "@/components/receipts/review/queue-rail";
import {
  QueueControlsProvider,
  QueueSortControl,
} from "@/components/receipts/review/queue-controls";
import type { QueueItem } from "@/lib/receipts/queue-items";
import {
  isConcreteMonth,
  type ReviewScope,
} from "@/lib/receipts/review-queue-filter";

const REVIEW_HINTS = [
  ["j / k", "next · prev"],
  ["s", "save & next"],
  ["c", "category"],
  ["a", "attendees"],
  ["o", "open original"],
  ["r", "rotate"],
] as const;

// The five review-closing-scope filter tabs. `key` is the `filter` query value.
// Legacy keys (attendees/purpose/reviewed) are accepted by the filter but fall
// back to All, so they are intentionally absent here.
const FILTER_TABS = [
  { key: "", label: "All" },
  { key: "needs", label: "Needs review" },
  { key: "amex", label: "AMEX" },
  { key: "non-amex", label: "Non-AMEX" },
] as const;

export function ReviewLayout({
  queueItems,
  activeId,
  queryParams,
  imagePane,
  formPane,
  needsAttention,
  workingSetCount,
  effectiveMonth,
  availableMonths,
  monthParam,
  activeFilter,
  scope,
  savedAtLabel,
}: {
  queueItems: QueueItem[];
  activeId: string | null;
  /** Query-string suffix preserved across j/k + next/prev navigation, e.g.
   *  "?month=2026-06&scope=closing&filter=needs". Empty for the default view. */
  queryParams: string;
  imagePane: ReactNode;
  formPane: ReactNode;
  /** Unlocked working-set receipts in the closing-attention set — drives the
   *  amber pill + progress. Equals the Needs review tab count for this scope. */
  needsAttention: number;
  /** Total receipts in the working set (drives the rail's progress bar only;
   *  not rendered as a header total). */
  workingSetCount: number;
  /** 'YYYY-MM' or 'all'. The month currently in view. */
  effectiveMonth: string;
  /** Distinct months for the picker (receipt months ∪ AMEX statement months ∪
   *  current month). */
  availableMonths: string[];
  /** Raw month param ('' | 'all' | 'YYYY-MM') for building control hrefs. */
  monthParam: string;
  activeFilter?: string | null;
  /** Current closing scope — drives the toggle's pressed state. */
  scope?: ReviewScope;
  savedAtLabel?: string;
}) {
  return (
    <QueueControlsProvider
      items={queueItems}
      activeId={activeId}
      queryParams={queryParams}
    >
      <div className="flex h-[calc(100vh-58px)] min-h-[640px] flex-col bg-gray-50">
        <SubHeader
          needsAttention={needsAttention}
          effectiveMonth={effectiveMonth}
          availableMonths={availableMonths}
          monthParam={monthParam}
          activeFilter={activeFilter ?? null}
          scope={scope ?? "calendar"}
        />
        {/* Phone: stack queue → image → form so each pane is full-width and
            swipable. Tablet+: 2-column with image / form side-by-side and the
            queue folded into a drawer above. Desktop: classic 3-column.       */}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="md:col-span-2 lg:col-span-1 lg:row-span-1 max-h-[40vh] overflow-auto border-b border-gray-200 lg:max-h-none lg:border-b-0 lg:border-r">
            <QueueRail
              totalUnreviewed={needsAttention}
              totalCaptured={workingSetCount}
            />
          </div>
          <div className="min-h-[50vh] lg:min-h-0">{imagePane}</div>
          <div className="min-h-0 overflow-y-auto border-t border-gray-200 md:border-l md:border-t-0">
            {formPane}
          </div>
        </div>
        <KeyboardHintBar
          hints={REVIEW_HINTS}
          trailing={
            savedAtLabel
              ? `Auto-saving every change · ${savedAtLabel}`
              : "Auto-saving every change"
          }
        />
      </div>
    </QueueControlsProvider>
  );
}

function SubHeader({
  needsAttention,
  effectiveMonth,
  availableMonths,
  monthParam,
  activeFilter,
  scope,
}: {
  needsAttention: number;
  effectiveMonth: string;
  availableMonths: string[];
  monthParam: string;
  activeFilter: string | null;
  scope: ReviewScope;
}) {
  const router = useRouter();
  const concrete = isConcreteMonth(monthParam);

  function pushQuery(next: { month?: string; scope?: ReviewScope; filter?: string | null }) {
    const params = new URLSearchParams();
    const month = next.month ?? monthParam;
    if (month) params.set("month", month);
    const filter = next.filter !== undefined ? next.filter : activeFilter || null;
    if (filter) params.set("filter", filter);
    const nextScope = next.scope ?? scope;
    // Closing scope is only meaningful for a concrete month; selecting 'all'
    // drops it (resolveReviewScope enforces the same server-side).
    if (nextScope === "closing" && isConcreteMonth(month)) params.set("scope", "closing");
    const qs = params.toString();
    router.push(qs ? `/receipts/review?${qs}` : "/receipts/review");
  }

  function onMonthChange(value: string) {
    // Preserve the workflow filter across month changes. Closing scope is
    // preserved too, except when switching to 'all' (no closing scope there).
    pushQuery({ month: value, scope: value === "all" ? "calendar" : scope });
  }

  function onToggleScope() {
    pushQuery({ scope: scope === "closing" ? "calendar" : "closing" });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-gray-200 bg-white px-4 py-2.5 md:px-8">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold text-gray-900">
          Review queue
        </span>
        <Pill tone="amber" size="sm" dot>
          {needsAttention} need attention
        </Pill>
      </div>

      <div className="flex items-center gap-1.5">
        {/* Month picker — server round-trip on change (the hybrid boundary). */}
        <select
          value={effectiveMonth}
          onChange={(e) => onMonthChange(e.target.value)}
          aria-label="Statement month"
          className="h-[30px] max-w-[8.5rem] rounded-[7px] border border-gray-200 bg-white px-2 text-[12px] text-gray-600 focus:outline-none"
        >
          {availableMonths.map((m) => (
            <option key={m} value={m}>
              {formatMonthLabel(m)}
            </option>
          ))}
          <option value="all">All months</option>
        </select>

        <ClosingScopeToggle
          pressed={scope === "closing"}
          disabled={!concrete}
          onClick={onToggleScope}
        />
      </div>

      {/* Tabs + sort: pushed right on desktop, wrap + scroll on mobile. */}
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <div
          className="flex min-w-0 items-center gap-1.5 overflow-x-auto"
          role="tablist"
          aria-label="Review queue filters"
        >
          {FILTER_TABS.map((f) => {
            const isActive = activeFilter === f.key;
            return (
              <Link
                key={f.key || "all"}
                href={reviewHref(f.key || null, monthParam, scope)}
                role="tab"
                aria-selected={isActive}
                className={[
                  "shrink-0 rounded-[7px] border px-2.5 py-1 text-xs",
                  isActive
                    ? "border-gray-900 bg-gray-900 font-semibold text-white"
                    : "border-gray-200 bg-white font-medium text-gray-600 hover:text-gray-900",
                ].join(" ")}
              >
                {f.label}
              </Link>
            );
          })}
          {/* Locked pill — visually distinct (gray, lock glyph) from the other
              tabs. Rendered unconditionally so the control doesn't jump. */}
          <Link
            href={reviewHref("locked", monthParam, scope)}
            role="tab"
            aria-selected={activeFilter === "locked"}
            className={[
              "flex shrink-0 items-center gap-1 rounded-[7px] border px-2.5 py-1 text-xs",
              activeFilter === "locked"
                ? "border-gray-500 bg-gray-100 font-semibold text-gray-700"
                : "border-gray-200 bg-white font-medium text-gray-500 hover:text-gray-700",
            ].join(" ")}
            title="Receipts sealed by a finalized export or reconciliation"
          >
            <LockIcon size={11} />
            Locked
          </Link>
        </div>
        <QueueSortControl />
      </div>
    </div>
  );
}

/** URL-backed "Closing scope" toggle. Pressed = closing scope on for the
 *  current statement month; disabled for 'All months' (no single closing
 *  scope). The actual URL change happens in the parent (pushQuery). */
function ClosingScopeToggle({
  pressed,
  disabled,
  onClick,
}: {
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      title="Show receipts included in this statement month’s closing."
      className={[
        "flex h-[30px] shrink-0 items-center gap-1.5 rounded-[7px] border px-2.5 text-[12px] font-medium",
        pressed
          ? "border-amber-500 bg-amber-50 text-amber-800"
          : "border-gray-200 bg-white text-gray-600 hover:text-gray-900",
        disabled ? "cursor-not-allowed opacity-40" : "",
      ].join(" ")}
    >
      <span
        className={[
          "flex h-3.5 w-6 items-center rounded-full px-0.5 transition-colors",
          pressed ? "bg-amber-500" : "bg-gray-300",
        ].join(" ")}
        aria-hidden
      >
        <span
          className={[
            "h-2.5 w-2.5 rounded-full bg-white transition-transform",
            pressed ? "translate-x-2.5" : "translate-x-0",
          ].join(" ")}
        />
      </span>
      Closing scope
    </button>
  );
}

/** Build a /receipts/review href that sets `filter` (null → "All") and
 *  preserves month + scope. Clicking a tab intentionally drops legacy
 *  status/payment_path deep-link params. */
function reviewHref(
  filter: string | null,
  monthParam: string,
  scope: ReviewScope,
): string {
  const params = new URLSearchParams();
  if (filter) params.set("filter", filter);
  if (monthParam) params.set("month", monthParam);
  if (scope === "closing" && isConcreteMonth(monthParam)) params.set("scope", "closing");
  const qs = params.toString();
  return qs ? `/receipts/review?${qs}` : "/receipts/review";
}

/** Friendly month label for the picker. */
function formatMonthLabel(month: string): string {
  if (month === "all") return "All";
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
