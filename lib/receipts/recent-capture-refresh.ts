// Pure (client-safe, dependency-free) scheduling policy for the Capture-page
// recent-captures refresh. Extracted from the React hook so the rules are
// unit-testable without a DOM or timer framework:
//
//   - a coalescing state machine that bounds in-flight fetches to one and
//     collapses a burst of concurrent requests into a single trailing refresh;
//   - the poll-activation decision (when to keep a background interval alive).
//
// No React, Next.js, runtime-binding, or DOM imports here.

/**
 * Coalesced-refresh state.
 *
 *   - `idle`            — nothing running, no trailing refresh wanted.
 *   - `active`          — one fetch in flight, no trailing refresh wanted (yet).
 *   - `active-trailing` — one fetch in flight AND a trailing refresh wanted.
 */
export type CoalescedRefreshState = "idle" | "active" | "active-trailing";

export type CoalescedRefreshEvent =
  | { type: "request" }
  | { type: "complete" };

/**
 * Advance the coalesced-refresh state machine.
 *
 *   idle            --request-->   active            (the fetch starts)
 *   active          --request-->   active-trailing   (one trailing wanted)
 *   active-trailing --request-->   active-trailing   (still just one trailing)
 *   active          --complete-->  idle              (nothing was trailing)
 *   active-trailing --complete-->  active            (trailing now starts)
 *
 * Net effect: at most one fetch runs at a time, and any number of requests that
 * arrive while a fetch is active collapse into exactly one trailing refresh
 * after it finishes — so concurrent desktop folder uploads converge on one
 * final read of the latest captures.
 */
export function reduceCoalescedRefresh(
  state: CoalescedRefreshState,
  event: CoalescedRefreshEvent,
): CoalescedRefreshState {
  switch (event.type) {
    case "request":
      return state === "idle" ? "active" : "active-trailing";
    case "complete":
      return state === "active-trailing" ? "active" : "idle";
  }
}

/**
 * Whether a fetch should physically start as a result of a transition. A fetch
 * starts exactly when we ENTER `"active"`: on the initial request (idle→active)
 * and again when a trailing request is promoted to active after the prior fetch
 * completes (active-trailing→active). It never starts on the request that only
 * schedules a trailing refresh.
 */
export function shouldStartFetch(
  prev: CoalescedRefreshState,
  next: CoalescedRefreshState,
): boolean {
  return next === "active" && prev !== "active";
}

/**
 * Whether background polling should be active (an interval + visibility
 * listener should exist). Polling runs while any visible item is still pending
 * OR a refresh is currently unavailable — the latter keeps a transient failure
 * retrying on the 15s cadence even when the displayed list has no pending item.
 *
 * The document-hidden check is applied per-tick (and on visibility change), NOT
 * here: this answers "should a timer exist at all", not "should this tick fire".
 */
export function shouldPollRecentCaptures(opts: {
  anyPending: boolean;
  refreshUnavailable: boolean;
}): boolean {
  return opts.anyPending || opts.refreshUnavailable;
}
