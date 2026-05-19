import { ReactNode } from "react";
import Link from "next/link";
import { Pill } from "@/components/ui/pill";
import { SearchIcon } from "@/components/ui/icons";
import { KeyboardHintBar } from "@/components/receipts/ui/keyboard-hint-bar";

const REVIEW_HINTS = [
  ["j / k", "next · prev"],
  ["s", "save & next"],
  ["c", "category"],
  ["a", "attendees"],
  ["o", "open original"],
  ["r", "rotate"],
] as const;

const FILTERS = [
  { label: "All", href: "/receipts/review" },
  { label: "Needs review", href: "/receipts/review?filter=needs" },
  { label: "Missing attendees", href: "/receipts/review?filter=attendees" },
  { label: "Missing purpose", href: "/receipts/review?filter=purpose" },
  { label: "Reviewed", href: "/receipts/review?filter=reviewed" },
] as const;

export function ReviewLayout({
  queueRail,
  imagePane,
  formPane,
  needsAttention,
  capturedThisMonth,
  activeFilter,
  savedAtLabel,
}: {
  queueRail: ReactNode;
  imagePane: ReactNode;
  formPane: ReactNode;
  needsAttention: number;
  capturedThisMonth: number;
  activeFilter?: string | null;
  savedAtLabel?: string;
}) {
  return (
    <div className="flex h-[calc(100vh-58px)] min-h-[640px] flex-col bg-gray-50">
      <SubHeader
        needsAttention={needsAttention}
        capturedThisMonth={capturedThisMonth}
        activeFilter={activeFilter ?? null}
      />
      {/* Phone: stack queue → image → form so each pane is full-width and
          swipable. Tablet+: 2-column with image / form side-by-side and the
          queue folded into a drawer above. Desktop: classic 3-column.       */}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="md:col-span-2 lg:col-span-1 lg:row-span-1 max-h-[40vh] overflow-auto border-b border-gray-200 lg:max-h-none lg:border-b-0 lg:border-r">
          {queueRail}
        </div>
        <div className="min-h-[50vh] lg:min-h-0">{imagePane}</div>
        <div className="border-t border-gray-200 md:border-l md:border-t-0">
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
  );
}

function SubHeader({
  needsAttention,
  capturedThisMonth,
  activeFilter,
}: {
  needsAttention: number;
  capturedThisMonth: number;
  activeFilter: string | null;
}) {
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
          · {capturedThisMonth} captured this month
        </span>
      </div>
      <span className="flex-1" />
      <div className="hidden gap-1.5 md:flex">
        {FILTERS.map((f) => {
          const isActive =
            (activeFilter ?? "") === filterKeyFromHref(f.href);
          return (
            <Link
              key={f.label}
              href={f.href}
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
      </div>
      <div className="flex items-center gap-1.5 rounded-[7px] border border-gray-200 px-2.5 py-1">
        <SearchIcon size={13} className="text-gray-400" />
        <span className="text-[12.5px] text-gray-400">
          Search merchant, amount…
        </span>
      </div>
    </div>
  );
}

function filterKeyFromHref(href: string): string {
  const idx = href.indexOf("filter=");
  return idx >= 0 ? href.slice(idx + 7) : "";
}
