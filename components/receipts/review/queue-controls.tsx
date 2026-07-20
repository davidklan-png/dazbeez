"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { QueueItem } from "@/lib/receipts/queue-items";
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  sortQueueItems,
  type SortKey,
} from "@/lib/receipts/queue-sort";

// Pure helpers (sortQueueItems, needsFirst, SortKey) live in
// lib/receipts/queue-sort.ts so they're unit-testable without a DOM. This file
// owns only the React state that bridges the SubHeader sort control ↔
// QueueRail ↔ FormPane.
//
// Those three components live in different layout regions, so a single provider
// owns the sort state and the derived `visible` list — keeping j/k and the
// "n of m" footer on the sorted+filtered order, not the server order. The
// client-side search control was removed (review-closing-scope UI); the sort
// selector remains.

type QueueControlsCtx = {
  /** Server-order items (the post-filter working set). */
  raw: QueueItem[];
  /** Sorted items — what the rail renders and j/k walks. */
  visible: QueueItem[];
  activeId: string | null;
  /** Query-string suffix preserved across j/k + next/prev navigation so the
   *  operator stays within the chosen month/scope/filter view, e.g.
   *  "?month=2026-06&scope=closing". */
  queryParams: string;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
};

const Ctx = createContext<QueueControlsCtx | null>(null);

export function useQueueControls(): QueueControlsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useQueueControls must be used inside <QueueControlsProvider>");
  }
  return ctx;
}

/** Position of a receipt within the sorted `visible` list, for FormPane's
 *  "n of m" and save-and-next navigation. Returns index -1 when the receipt is
 *  filtered out (caller falls back to server-computed values). */
export function useQueuePosition(receiptId: string): {
  index: number;
  total: number;
  nextId: string | null;
  prevId: string | null;
} {
  const { visible } = useQueueControls();
  return useMemo(() => {
    const idx = visible.findIndex((i) => i.id === receiptId);
    if (idx < 0) return { index: -1, total: visible.length, nextId: null, prevId: null };
    return {
      index: idx + 1,
      total: visible.length,
      nextId: visible[idx + 1]?.id ?? null,
      prevId: visible[idx - 1]?.id ?? null,
    };
  }, [visible, receiptId]);
}

export function QueueControlsProvider({
  items,
  activeId,
  queryParams,
  children,
}: {
  items: QueueItem[];
  activeId: string | null;
  queryParams: string;
  children: ReactNode;
}) {
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);

  const visible = useMemo(
    () => sortQueueItems(items, sortKey),
    [items, sortKey],
  );

  const value = useMemo<QueueControlsCtx>(
    () => ({ raw: items, visible, activeId, queryParams, sortKey, setSortKey }),
    [items, visible, activeId, queryParams, sortKey],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Sort-only control (the search field was removed). Lives in the SubHeader. */
export function QueueSortControl() {
  const { sortKey, setSortKey } = useQueueControls();
  return (
    <select
      value={sortKey}
      onChange={(e) => setSortKey(e.target.value as SortKey)}
      aria-label="Sort queue"
      className="h-[30px] shrink-0 rounded-[7px] border border-gray-200 bg-white px-2 text-[12px] text-gray-600 focus:outline-none"
    >
      {SORT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
