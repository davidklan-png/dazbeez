"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";
import { Kbd } from "@/components/ui/kbd";
import { ReceiptThumb } from "@/components/receipts/ui/receipt-thumb";
import { useKeyboardShortcuts } from "@/lib/receipts/keyboard";
import type { QueueItem } from "@/lib/receipts/queue-items";

export function QueueRail({
  items,
  activeId,
  totalUnreviewed,
  totalCaptured,
}: {
  items: QueueItem[];
  activeId: string | null;
  totalUnreviewed: number;
  totalCaptured: number;
}) {
  const router = useRouter();
  const activeIndex = useMemo(
    () => items.findIndex((i) => i.id === activeId),
    [items, activeId],
  );
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  useKeyboardShortcuts({
    j: () => navigate(1),
    k: () => navigate(-1),
    arrowdown: () => navigate(1),
    arrowup: () => navigate(-1),
  });

  function navigate(delta: number) {
    if (items.length === 0) return;
    const fallback = delta > 0 ? 0 : items.length - 1;
    const idx = activeIndex < 0 ? fallback : activeIndex;
    const next = items[(idx + delta + items.length) % items.length];
    if (next) router.push(`/receipts/review/${next.id}`);
  }

  const doneSoFar = Math.max(0, totalCaptured - totalUnreviewed);
  const pct = totalCaptured ? Math.round((doneSoFar / totalCaptured) * 100) : 0;

  return (
    <aside className="flex h-full flex-col overflow-hidden border-r border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-150 px-3.5 py-3">
        <div className="text-[12px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          {totalUnreviewed} in queue
        </div>
        <div className="flex gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {items.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12.5px] text-gray-400">
            All caught up. Nothing left to review.
          </div>
        ) : (
          items.map((item) => (
            <Link
              key={item.id}
              href={`/receipts/review/${item.id}`}
              ref={item.id === activeId ? activeRef : null}
              aria-current={item.id === activeId ? "page" : undefined}
              className={[
                "flex gap-2.5 border-b border-gray-100 px-3.5 py-2.5 transition-colors",
                item.id === activeId
                  ? "border-l-[3px] border-l-amber-500 bg-amber-50"
                  : "border-l-[3px] border-l-transparent hover:bg-gray-50",
              ].join(" ")}
            >
              <ReceiptThumb
                size={36}
                merchant={item.merchant.toUpperCase().slice(0, 8)}
                amount={item.amountLabel}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="max-w-[160px] truncate text-[12.5px] font-semibold text-gray-900">
                    {item.merchant}
                  </span>
                  <span className="text-[12px] font-semibold tabular-nums text-gray-900">
                    {item.amountLabel}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500">
                  <span>{item.dateLabel}</span>
                  <span className="h-[3px] w-[3px] rounded-full bg-gray-300" />
                  <span className="truncate">{item.categoryLabel}</span>
                </div>
                {item.needs && (
                  <span className="mt-1 inline-block rounded bg-amber-100 px-1.5 py-px text-[10px] font-semibold text-amber-700">
                    needs {item.needs}
                  </span>
                )}
              </div>
            </Link>
          ))
        )}
      </div>

      <div className="flex items-center gap-2.5 border-t border-gray-150 px-3.5 py-2.5 text-[11.5px] text-gray-500">
        <span>
          {doneSoFar} of {totalCaptured} done
        </span>
        <div className="h-1 flex-1 overflow-hidden rounded bg-gray-100">
          <div
            className="h-full rounded bg-amber-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </aside>
  );
}
