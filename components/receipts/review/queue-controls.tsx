"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { QueueItem } from "@/lib/receipts/queue-items";
import { guardedNavigate } from "@/lib/receipts/review-navigation";
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  sortQueueItems,
  type SortKey,
} from "@/lib/receipts/queue-sort";
import { buildReviewControlQuery, type ReviewScope } from "@/lib/receipts/review-queue-filter";

// Pure helpers (sortQueueItems, needsFirst, SortKey) live in
// lib/receipts/queue-sort.ts so they're unit-testable without a DOM. This file
// owns only the React state that bridges the SubHeader sort control ↔
// QueueRail ↔ FormPane.
//
// Those three components live in different layout regions, so a single provider
// owns the sort state and the derived `visible` list — keeping j/k and the
// "n of m" footer on the sorted+filtered order, not the server order. The
// old client-side (in-rail) search control was removed with the
// review-closing-scope UI; cross-month search (TASK-041) is server-side and
// URL-driven — see ReviewSearchControl below.

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

/** Sort control. Lives in the SubHeader. */
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

/** Cross-month receipt search (TASK-041). Server-controlled: defaultValue from
 *  the URL, Enter submits a router.push, ✕ clears — no client state library.
 *  Search ignores month/scope (the server swaps in the search working set), so
 *  the input builds its URL from the CURRENT control state and only `q` is
 *  meaningful to the server while set. */
export function ReviewSearchControl({
  monthParam,
  filter,
  scope,
  defaultValue,
  matchCount,
}: {
  monthParam: string;
  filter: string | null;
  scope: ReviewScope;
  /** Current `q` ('' when inactive). */
  defaultValue: string;
  /** Server-side match count; undefined when unknown (the [id] page) — the
   *  "N matches" label is then omitted. */
  matchCount?: number;
}) {
  const router = useRouter();

  function push(q: string) {
    // Search submits/clears can leave the review form mid-debounce — await
    // its pending edits before navigating (no-op when no form is mounted,
    // e.g. on the list page). Push semantics preserved.
    void guardedNavigate(() =>
      router.push(
        `/receipts/review${buildReviewControlQuery({
          month: monthParam,
          filter,
          scope,
          q: q || undefined,
        })}`,
      ),
    );
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = (e.currentTarget.elements.namedItem("q") as HTMLInputElement)
      .value
      .trim()
      .slice(0, 100);
    push(value);
  }

  return (
    <form onSubmit={onSubmit} className="flex min-w-0 items-center gap-1.5">
      <input
        // key forces the uncontrolled input to reset when navigation changes q.
        key={defaultValue}
        type="text"
        name="q"
        defaultValue={defaultValue}
        placeholder="Search receipts…"
        aria-label="Search receipts (all months)"
        className="h-[30px] w-36 min-w-0 rounded-[7px] border border-gray-200 bg-white px-2 text-[12px] text-gray-600 focus:outline-none sm:w-56"
      />
      {defaultValue && (
        <>
          {matchCount !== undefined && (
            <span className="hidden whitespace-nowrap text-[11px] text-gray-400 sm:inline">
              {matchCount} matches · all months
            </span>
          )}
          <button
            type="button"
            onClick={() => push("")}
            aria-label="Clear search"
            title="Clear search"
            className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-[11px] leading-none text-gray-600 hover:bg-gray-300"
          >
            ✕
          </button>
        </>
      )}
    </form>
  );
}
