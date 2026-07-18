"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { SearchIcon } from "@/components/ui/icons";
import { useKeyboardShortcuts } from "@/lib/receipts/keyboard";
import type { QueueItem } from "@/lib/receipts/queue-items";
import {
  DEFAULT_SORT,
  SORT_OPTIONS,
  searchQueueItems,
  sortQueueItems,
  type SortKey,
} from "@/lib/receipts/queue-sort";

// Pure helpers (searchQueueItems, sortQueueItems, needsFirst, SortKey) live in
// lib/receipts/queue-sort.ts so they're unit-testable without a DOM. This file
// owns only the React state that bridges the SubHeader search bar ↔ QueueRail
// ↔ FormPane, and the keyboard wiring.
//
// Those three components live in different layout regions, so a single provider
// owns the sort + search state and the derived `visible` list — keeping j/k
// and the "n of m" footer on the sorted+filtered order, not the server order.

type QueueControlsCtx = {
  /** Server-order items (the post-filter working set). */
  raw: QueueItem[];
  /** Sorted + filtered items — what the rail renders and j/k walks. */
  visible: QueueItem[];
  activeId: string | null;
  /** Query-string suffix preserved across j/k + next/prev navigation so the
   *  operator stays within the chosen month/filter view, e.g. "?month=2026-06". */
  queryParams: string;
  query: string;
  setQuery: (q: string) => void;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
  inputRef: RefObject<HTMLInputElement | null>;
};

const Ctx = createContext<QueueControlsCtx | null>(null);

export function useQueueControls(): QueueControlsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useQueueControls must be used inside <QueueControlsProvider>");
  }
  return ctx;
}

/** Position of a receipt within the sorted+filtered `visible` list, for
 *  FormPane's "n of m" and save-and-next navigation. Returns index -1 when
 *  the receipt is filtered out (caller falls back to server-computed values). */
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
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>(DEFAULT_SORT);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const visible = useMemo(
    () => sortQueueItems(searchQueueItems(items, query), sortKey),
    [items, query, sortKey],
  );

  // `/` focuses search (the hook skips typing targets by default, so `/` typed
  // into a field stays a character); Escape clears it (allowInInputs lets the
  // key reach the handler while the search field itself is focused).
  useKeyboardShortcuts(
    {
      "/": (e) => {
        e.preventDefault();
        inputRef.current?.focus();
      },
      escape: () => setQuery(""),
    },
    { allowInInputs: ["escape"] },
  );

  const value = useMemo<QueueControlsCtx>(
    () => ({ raw: items, visible, activeId, queryParams, query, setQuery, sortKey, setSortKey, inputRef }),
    [items, visible, activeId, queryParams, query, sortKey],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function QueueSearchBar() {
  const { query, setQuery, sortKey, setSortKey, inputRef } = useQueueControls();
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-1.5 rounded-[7px] border border-gray-200 px-2.5 py-1">
        <SearchIcon size={13} className="text-gray-400" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search merchant, amount…"
          className="w-40 bg-transparent text-[12.5px] text-gray-700 placeholder:text-gray-400 focus:outline-none"
          aria-label="Search queue"
        />
      </div>
      <select
        value={sortKey}
        onChange={(e) => setSortKey(e.target.value as SortKey)}
        aria-label="Sort queue"
        className="h-[30px] rounded-[7px] border border-gray-200 bg-white px-2 text-[12px] text-gray-600 focus:outline-none"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
