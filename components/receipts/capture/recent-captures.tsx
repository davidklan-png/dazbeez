"use client";

import Link from "next/link";
import { ArrowRightIcon } from "@/components/ui/icons";
import { formatAmountMinor } from "@/lib/receipts/format";
import {
  deriveRecentCaptureStatus,
  type RecentCapture,
  type RecentCaptureTone,
} from "@/lib/receipts/recent-captures";
import { withWorkMonth } from "@/lib/receipts/work-month";

// Recent-capture status dot/text colors. Decoupled from the shared Pill
// component (which has no "charcoal" tone) so exported (charcoal) and
// reconciled (green) read as distinct, per the Capture-page status spec.
const TONE_DOT: Record<RecentCaptureTone, string> = {
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  charcoal: "bg-gray-900",
  gray: "bg-gray-400",
};
const TONE_TEXT: Record<RecentCaptureTone, string> = {
  red: "text-red-600",
  amber: "text-amber-700",
  green: "text-green-700",
  charcoal: "text-gray-900",
  gray: "text-gray-600",
};

function formatCapturedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * The row label: merchant when known, else filename, else the short receipt id
 * — never blank, and never the raw UUID.
 */
function rowPrimary(item: RecentCapture): string {
  if (item.merchant && item.merchant.trim()) return item.merchant;
  if (item.original_filename && item.original_filename.trim())
    return item.original_filename;
  return `R-${item.id.slice(0, 8)}`;
}

function StatusBadge({
  tone,
  label,
}: {
  tone: RecentCaptureTone;
  label: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold ${TONE_TEXT[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]}`} />
      {label}
    </span>
  );
}

function RecentCaptureRow({
  item,
  workMonth,
}: {
  item: RecentCapture;
  workMonth: string | null;
}) {
  const status = deriveRecentCaptureStatus(item);
  const href = withWorkMonth(`/receipts/review/${item.id}`, workMonth);
  const amount =
    item.amount_minor != null
      ? formatAmountMinor(item.amount_minor, item.currency ?? "JPY")
      : null;

  return (
    <li className="border-t border-gray-100 first:border-t-0">
      <Link
        href={href}
        className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-amber-50/60"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-gray-900">
            {rowPrimary(item)}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-gray-500">
            {formatCapturedAt(item.captured_at)}
            {amount && (
              <>
                <span className="mx-1.5 text-gray-300">·</span>
                <span className="tabular-nums">{amount}</span>
              </>
            )}
          </div>
        </div>
        <StatusBadge tone={status.tone} label={status.label} />
        <ArrowRightIcon
          size={13}
          className="shrink-0 text-gray-300 group-hover:text-gray-500"
        />
      </Link>
    </li>
  );
}

/**
 * Persistent, DB-backed recent-captures rail for the Capture page. Renders the
 * latest few captures with live status, each deep-linked into Review (carrying
 * the work month). Distinct from the in-memory session batch — this is history
 * that survives reloads.
 *
 * `variant="card"` (desktop) wraps the list in a bordered card with a header;
 * `variant="inline"` (mobile) is a lighter block suited to the scrollable
 * mobile capture screen.
 */
export function RecentCaptures({
  items,
  workMonth,
  variant = "card",
}: {
  items: RecentCapture[];
  workMonth: string | null;
  variant?: "card" | "inline";
}) {
  const header = (
    <div className="flex items-baseline gap-2.5">
      <span className="text-[13px] font-semibold text-gray-900">
        Recent captures
      </span>
      {items.length > 0 && (
        <span className="text-[11.5px] text-gray-400">
          latest {items.length}
        </span>
      )}
    </div>
  );

  const list = items.length === 0 ? (
    <div className="px-3 py-6 text-center text-[12.5px] text-gray-400">
      Nothing captured yet.
    </div>
  ) : (
    <ul className="group">
      {items.map((item) => (
        <RecentCaptureRow key={item.id} item={item} workMonth={workMonth} />
      ))}
    </ul>
  );

  if (variant === "inline") {
    return (
      <section className="mt-4">
        {header}
        <div className="mt-2 overflow-hidden rounded-xl border border-gray-200 bg-white">
          {list}
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2.5">{header}</div>
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        {list}
      </div>
    </section>
  );
}
