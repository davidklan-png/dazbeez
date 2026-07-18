"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ReactNode } from "react";
import { Pill } from "@/components/ui/pill";
import { LockIcon } from "@/components/ui/icons";
import { KeyboardHintBar } from "@/components/receipts/ui/keyboard-hint-bar";
import { OcrHealthChip } from "@/components/receipts/review/ocr-health-chip";
import { QueueRail } from "@/components/receipts/review/queue-rail";
import {
  QueueControlsProvider,
  QueueSearchBar,
} from "@/components/receipts/review/queue-controls";
import type { ExtractionHealth } from "@/lib/receipts/extraction-state";
import type { QueueItem } from "@/lib/receipts/queue-items";

const REVIEW_HINTS = [
  ["j / k", "next · prev"],
  ["s", "save & next"],
  ["c", "category"],
  ["a", "attendees"],
  ["o", "open original"],
  ["r", "rotate"],
  ["/", "search"],
] as const;

const FILTER_KEYS = [
  { key: "", label: "All" },
  { key: "needs", label: "Needs review" },
  { key: "attendees", label: "Missing attendees" },
  { key: "purpose", label: "Missing purpose" },
  { key: "reviewed", label: "Reviewed" },
] as const;

export function ReviewLayout({
  queueItems,
  activeId,
  queryParams,
  imagePane,
  formPane,
  needsAttention,
  workingSetCount,
  lockedCount,
  effectiveMonth,
  availableMonths,
  monthParam,
  activeFilter,
  ocrHealth,
  savedAtLabel,
}: {
  queueItems: QueueItem[];
  activeId: string | null;
  /** Query-string suffix preserved across j/k + next/prev navigation, e.g.
   *  "?month=2026-06&filter=locked". Empty for the default (no params) view. */
  queryParams: string;
  imagePane: ReactNode;
  formPane: ReactNode;
  /** Unlocked needs-review/captured count — drives the amber pill + progress. */
  needsAttention: number;
  /** Total receipts in the month scope (label "N in <month>"). */
  workingSetCount: number;
  /** Locked receipts in the month scope (muted "{n} locked" link to the filter). */
  lockedCount: number;
  /** 'YYYY-MM' or 'all'. The month currently in view (current calendar month
   *  when the operator is on the default / no param). */
  effectiveMonth: string;
  /** Distinct transaction months present in the data, for the picker. The
   *  server guarantees the current month is included. */
  availableMonths: string[];
  /** Raw month param ('' | 'all' | 'YYYY-MM') for building filter-pill hrefs. */
  monthParam: string;
  activeFilter?: string | null;
  ocrHealth?: ExtractionHealth;
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
          workingSetCount={workingSetCount}
          lockedCount={lockedCount}
          effectiveMonth={effectiveMonth}
          availableMonths={availableMonths}
          monthParam={monthParam}
          activeFilter={activeFilter ?? null}
          ocrHealth={ocrHealth}
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
  workingSetCount,
  lockedCount,
  effectiveMonth,
  availableMonths,
  monthParam,
  activeFilter,
  ocrHealth,
}: {
  needsAttention: number;
  workingSetCount: number;
  lockedCount: number;
  effectiveMonth: string;
  availableMonths: string[];
  monthParam: string;
  activeFilter: string | null;
  ocrHealth?: ExtractionHealth;
}) {
  const router = useRouter();

  function onMonthChange(value: string) {
    // value is 'all' or YYYY-MM. Preserve the current workflow filter so
    // flipping months doesn't drop the operator out of e.g. "Needs review".
    const params = new URLSearchParams();
    params.set("month", value);
    if (activeFilter) params.set("filter", activeFilter);
    router.push(`/receipts/review?${params.toString()}`);
  }

  const monthLabel = formatMonthLabel(effectiveMonth);

  return (
    <div className="flex items-center gap-3.5 border-b border-gray-200 bg-white px-8 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] font-semibold text-gray-900">
          Review queue
        </span>
        <Pill tone="amber" size="sm" dot>
          {needsAttention} need attention
        </Pill>
        <span className="text-xs text-gray-400">
          · {workingSetCount} {effectiveMonth === "all" ? "recent" : `in ${monthLabel}`}
        </span>
        {lockedCount > 0 && (
          <Link
            href={reviewHref("locked", monthParam)}
            className="text-xs text-gray-400 underline-offset-2 hover:text-gray-600 hover:underline"
            title="Receipts sealed by a finalized export or reconciliation"
          >
            · {lockedCount} locked
          </Link>
        )}
        {ocrHealth && <OcrHealthChip health={ocrHealth} />}
      </div>

      {/* Month picker — server round-trip on change (the hybrid boundary). */}
      <select
        value={effectiveMonth}
        onChange={(e) => onMonthChange(e.target.value)}
        aria-label="Statement month"
        className="h-[30px] rounded-[7px] border border-gray-200 bg-white px-2 text-[12px] text-gray-600 focus:outline-none"
      >
        {availableMonths.map((m) => (
          <option key={m} value={m}>
            {formatMonthLabel(m)}
          </option>
        ))}
        <option value="all">All months</option>
      </select>

      <span className="flex-1" />

      <div className="hidden gap-1.5 md:flex">
        {FILTER_KEYS.map((f) => {
          const isActive = (activeFilter ?? "") === f.key;
          return (
            <Link
              key={f.key || "all"}
              href={reviewHref(f.key || null, monthParam)}
              className={[
                "rounded-[7px] border px-2.5 py-1 text-xs",
                isActive
                  ? "border-gray-900 bg-gray-900 font-semibold text-white"
                  : "border-gray-200 bg-white font-medium text-gray-600 hover:text-gray-900",
              ].join(" ")}
            >
              {f.label}
            </Link>
          );
        })}
        {/* Locked pill — visually distinct (gray, lock glyph) from the workflow
            filters. Only meaningful when there are locked receipts, but render
            unconditionally so the control doesn't jump around as counts change. */}
        <Link
          href={reviewHref("locked", monthParam)}
          className={[
            "flex items-center gap-1 rounded-[7px] border px-2.5 py-1 text-xs",
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
      <QueueSearchBar />
    </div>
  );
}

/** Build a /receipts/review href that sets `filter` (null drops it → "All")
 *  and preserves the month param so flipping workflow filters stays within the
 *  chosen month. */
function reviewHref(filter: string | null, monthParam: string): string {
  const params = new URLSearchParams();
  if (filter) params.set("filter", filter);
  if (monthParam) params.set("month", monthParam);
  const qs = params.toString();
  return qs ? `/receipts/review?${qs}` : "/receipts/review";
}

/** Friendly month label for the picker + count. 'all' → "recent" only in the
 *  count context (handled by callers); here 'all' returns "All". */
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
