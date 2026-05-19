"use client";

import { useEffect, useState } from "react";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

/**
 * Inline "Saving… / Saved Xs ago / error" indicator for the review form.
 * Lives in its own file so form-pane stays focused on the receipt fields.
 */
export function SaveBadge({ state }: { state: SaveState }) {
  const ago = useElapsedSeconds(state.kind === "saved" ? state.at : null);

  if (state.kind === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-amber-700">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        Saving…
      </span>
    );
  }
  if (state.kind === "saved") {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        Saved · {ago}s ago
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="flex items-center gap-1.5 text-[11.5px] text-red-600">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        {state.message}
      </span>
    );
  }
  return null;
}

function useElapsedSeconds(at: number | null): number {
  const [now, setNow] = useState<number | null>(at);
  useEffect(() => {
    if (at == null) return;
    const tick = () => setNow(Date.now());
    const start = setTimeout(tick, 0);
    const interval = setInterval(tick, 1000);
    return () => {
      clearTimeout(start);
      clearInterval(interval);
    };
  }, [at]);
  return at == null || now == null
    ? 0
    : Math.max(1, Math.round((now - at) / 1000));
}
