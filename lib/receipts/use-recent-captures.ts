"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isRecentCapturePending,
  RECENT_CAPTURE_POLL_MS,
  type RecentCapture,
} from "@/lib/receipts/recent-captures";
import {
  reduceCoalescedRefresh,
  shouldPollRecentCaptures,
  shouldStartFetch,
  type CoalescedRefreshState,
} from "@/lib/receipts/recent-capture-refresh";

const RECENT_ENDPOINT = "/api/receipts/recent";

/**
 * Owns the Capture-page "Recent captures" state. Seeded from the server (initial
 * SSR list) so the rail renders before any client fetch, then kept live by:
 *
 *   - `refresh()` — called by the host after each successful desktop/mobile
 *     upload, and by the polling/visibility paths. Refresh requests are
 *     COALESCED: at most one fetch runs at a time, and a burst of concurrent
 *     requests (e.g. a desktop folder upload where several files finish in
 *     quick succession) collapses into exactly one trailing refresh, so the
 *     list converges on the latest captures. See recent-capture-refresh.ts.
 *
 * Polling (a 15s interval + a visibility listener) is active while any visible
 * item is still pending OR a refresh is currently unavailable:
 *
 *   - A pending item is `captured` / `queued` / `processing` / `needs_render=1`.
 *     A permanently-failed extraction is terminal and does NOT keep polling.
 *   - A failed / non-2xx refresh marks `refreshUnavailable` (the last good list
 *     is retained) and keeps retrying on the 15s cadence until a refresh
 *     succeeds — even when the displayed list has no pending item.
 *
 * Polling never issues a request while the document is hidden, and refreshes
 * immediately when the tab becomes visible again.
 */
export function useRecentCaptures(initial: RecentCapture[]) {
  const [items, setItems] = useState<RecentCapture[]>(initial);
  const [refreshUnavailable, setRefreshUnavailable] = useState(false);

  // Coalescing state lives in a ref — it's internal scheduling, not render
  // state. onComplete is held in a ref so the completion chain can always call
  // the latest handler without re-creating the stable `refresh` callback.
  const stateRef = useRef<CoalescedRefreshState>("idle");
  const onCompleteRef = useRef<() => void>(() => {});

  const runFetch = useCallback(async () => {
    try {
      const res = await fetch(RECENT_ENDPOINT, { method: "GET" });
      if (!res.ok) {
        // Retain the last good list; mark unavailable so polling retries.
        setRefreshUnavailable(true);
        return;
      }
      const json = (await res.json()) as { items?: RecentCapture[] };
      if (Array.isArray(json.items)) {
        setItems(json.items);
        setRefreshUnavailable(false);
      } else {
        setRefreshUnavailable(true);
      }
    } catch {
      // Network blip / throw — keep the last good list and retry via polling.
      setRefreshUnavailable(true);
    }
  }, []);

  // Wire the completion handler once (runFetch is stable). It advances the state
  // machine and starts the trailing fetch when one was requested mid-flight.
  useEffect(() => {
    const onComplete = () => {
      const prev = stateRef.current;
      const next = reduceCoalescedRefresh(prev, { type: "complete" });
      stateRef.current = next;
      if (shouldStartFetch(prev, next)) {
        void runFetch().finally(() => onCompleteRef.current());
      }
    };
    onCompleteRef.current = onComplete;
  }, [runFetch]);

  const refresh = useCallback(() => {
    const prev = stateRef.current;
    const next = reduceCoalescedRefresh(prev, { type: "request" });
    stateRef.current = next;
    if (shouldStartFetch(prev, next)) {
      void runFetch().finally(() => onCompleteRef.current());
    }
  }, [runFetch]);

  const anyPending = useMemo(
    () => items.some(isRecentCapturePending),
    [items],
  );

  // Polling: active when pending OR unavailable. Per-tick and per-visibility the
  // document-hidden check gates the actual fetch.
  useEffect(() => {
    if (!shouldPollRecentCaptures({ anyPending, refreshUnavailable })) return;

    const isHidden = () =>
      typeof document !== "undefined" && document.hidden;

    const tick = () => {
      if (isHidden()) return; // never poll while hidden
      void refresh();
    };
    const onVisibility = () => {
      if (isHidden()) return; // refresh the moment the tab is visible again
      void refresh();
    };

    const id = window.setInterval(tick, RECENT_CAPTURE_POLL_MS);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      window.clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [anyPending, refreshUnavailable, refresh]);

  return { items, refresh, refreshUnavailable };
}
