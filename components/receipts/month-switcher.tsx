import Link from "next/link";
import { withWorkMonth } from "@/lib/receipts/work-month";
import {
  deliveryStateToPill,
  type DeliveryState,
} from "@/lib/receipts/delivery-state";

export interface MonthOption {
  month: string;
  lineCount: number;
  unmatchedCount: number;
  status: "draft" | "finalized" | null;
  /** Per-month delivery state (delivery-composer §6). OPTIONAL because
   *  MonthSwitcher is shared with the reconcile and AMEX pages, which must keep
   *  compiling and rendering unchanged — only the export page populates it.
   *  `undefined` = not provided (keep existing pill behaviour). `null` = sealed,
   *  never attempted (a real value → red, action-needed). */
  deliveryState?: DeliveryState | null;
}

interface MonthSwitcherProps {
  months: MonthOption[];
  activeMonth: string;
  basePath: string;
}

export function MonthSwitcher({ months, activeMonth, basePath }: MonthSwitcherProps) {
  if (months.length === 0) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        No AMEX statements imported yet.{" "}
        <Link
          href={withWorkMonth("/receipts/amex", activeMonth)}
          className="font-medium underline hover:text-amber-900"
        >
          Upload one
        </Link>{" "}
        to start reconciling.
      </div>
    );
  }

  const activeIndex = months.findIndex((m) => m.month === activeMonth);
  const prevMonth = activeIndex > 0 ? months[activeIndex - 1]!.month : null;
  const nextMonth =
    activeIndex >= 0 && activeIndex < months.length - 1
      ? months[activeIndex + 1]!.month
      : null;

  const isActiveInList = activeIndex >= 0;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2 overflow-x-auto">
        <NavArrow
          href={prevMonth ? `${basePath}?month=${prevMonth}` : null}
          direction="prev"
        />
        <div className="flex flex-1 flex-wrap items-center gap-2">
          {months.map((m) => (
            <MonthPill
              key={m.month}
              option={m}
              active={m.month === activeMonth}
              basePath={basePath}
            />
          ))}
          {!isActiveInList && (
            <span className="rounded-xl border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-500">
              {activeMonth} (no statement)
            </span>
          )}
        </div>
        <NavArrow
          href={nextMonth ? `${basePath}?month=${nextMonth}` : null}
          direction="next"
        />
      </div>
    </div>
  );
}

function MonthPill({
  option,
  active,
  basePath,
}: {
  option: MonthOption;
  active: boolean;
  basePath: string;
}) {
  const base =
    "flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap";
  const style = active
    ? "bg-amber-500 text-white hover:bg-amber-600"
    : "bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200";

  return (
    <Link href={`${basePath}?month=${option.month}`} className={`${base} ${style}`}>
      <span className="font-semibold">{option.month}</span>
      <span className={active ? "text-amber-50" : "text-gray-500"}>
        {option.lineCount} line{option.lineCount !== 1 ? "s" : ""}
      </span>
      <StatusDot
        status={option.status}
        unmatchedCount={option.unmatchedCount}
        active={active}
        deliveryState={option.deliveryState}
      />
    </Link>
  );
}

function StatusDot({
  status,
  unmatchedCount,
  active,
  deliveryState,
}: {
  status: "draft" | "finalized" | null;
  unmatchedCount: number;
  active: boolean;
  deliveryState?: DeliveryState | null;
}) {
  if (status === "finalized") {
    // Only colour by delivery when the caller populated deliveryState (export
    // page). Reconcile/AMEX pages leave it undefined → keep the legacy green ✓.
    if (deliveryState !== undefined) {
      const pill = deliveryStateToPill(deliveryState);
      if (pill === "undelivered") {
        return (
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
              active ? "bg-white text-red-600" : "bg-red-100 text-red-700"
            }`}
            title="未送信 — 未クローズ (sealed, not yet delivered)"
          >
            !
          </span>
        );
      }
      if (pill === "pending") {
        return (
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
              active ? "bg-white text-blue-600" : "bg-blue-100 text-blue-700"
            }`}
            title="送信中 (delivery in flight)"
          >
            …
          </span>
        );
      }
    }
    return (
      <span
        className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
          active ? "bg-white text-amber-600" : "bg-green-100 text-green-700"
        }`}
        title="Signed off"
      >
        ✓
      </span>
    );
  }
  if (unmatchedCount > 0) {
    return (
      <span
        className={`inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] ${
          active ? "bg-white text-amber-700" : "bg-amber-100 text-amber-700"
        }`}
        title={`${unmatchedCount} unresolved`}
      >
        {unmatchedCount}
      </span>
    );
  }
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        active ? "bg-white" : "bg-gray-300"
      }`}
      title="All lines resolved"
    />
  );
}

function NavArrow({
  href,
  direction,
}: {
  href: string | null;
  direction: "prev" | "next";
}) {
  const symbol = direction === "prev" ? "‹" : "›";
  if (!href) {
    return (
      <span className="rounded-lg px-2 py-1 text-gray-300" aria-hidden>
        {symbol}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded-lg px-2 py-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
      aria-label={direction === "prev" ? "Previous month" : "Next month"}
    >
      {symbol}
    </Link>
  );
}
