"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isRecentCapturePending,
  RECENT_CAPTURE_POLL_MS,
  type RecentCapture,
} from "@/lib/receipts/recent-captures";

const RECENT_ENDPOINT = "/api/receipts/recent";

/**
 * Owns the Capture-page "Recent captures" state. Seeded from the server
 * (initial SSR list) so the rail renders before any client fetch, then kept
 * live by:
 *
 *   - `refresh()` — called by the host after each successful desktop/mobile
 *     upload, so the new capture appears immediately.
 *   - a 15s interval while ANY visible item is still pending (captured /
 *     queued / processing / needs_render=1); a permanently-failed extraction
 *     is terminal and does not keep polling.
 *
 * Polling never fires while the document is hidden, and resumes on the first
 * tick after the tab is visible again. Once nothing is pending the interval is
 * torn down entirely (no idle polling).
 */
export function useRecentCaptures(initial: RecentCapture[]) {
  const [items, setItems] = useState<RecentCapture[]>(initial);
  // In-flight refresh guard so a manual refresh + a polling tick don't race.
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await fetch(RECENT_ENDPOINT, { method: "GET" });
      if (!res.ok) return;
      const json = (await res.json()) as { items?: RecentCapture[] };
      if (Array.isArray(json.items)) setItems(json.items);
    } catch {
      // Network blips are non-fatal — the next tick retries. Never surface a
      // throw to the host; the rail just keeps its last good list.
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const anyPending = items.some(isRecentCapturePending);
    if (!anyPending) return; // nothing to watch — no timer, no listener.

    const tick = () => {
      if (typeof document === "undefined" || document.hidden) return;
      void refresh();
    };
    const onVisibility = () => {
      // Refresh the moment the tab becomes visible again so a capture that
      // finished while hidden reflects immediately.
      if (typeof document === "undefined" || document.hidden) return;
      void refresh();
    };

    const id = window.setInterval(tick, RECENT_CAPTURE_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [items, refresh]);

  return { items, refresh };
}
