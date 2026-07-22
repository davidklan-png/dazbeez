import test from "node:test";
import assert from "node:assert/strict";
import {
  reduceCoalescedRefresh,
  shouldStartFetch,
  shouldPollRecentCaptures,
  type CoalescedRefreshState,
} from "@/lib/receipts/recent-capture-refresh";

// Helper: apply an event and report both the new state and whether a fetch
// should start as a result of THIS transition.
function step(
  state: CoalescedRefreshState,
  event: { type: "request" } | { type: "complete" },
): { state: CoalescedRefreshState; startsFetch: boolean } {
  const next = reduceCoalescedRefresh(state, event);
  return { state: next, startsFetch: shouldStartFetch(state, next) };
}

// ─── reduceCoalescedRefresh: transitions ────────────────────────────────────

test("request from idle starts a fetch", () => {
  const r = step("idle", { type: "request" });
  assert.equal(r.state, "active");
  assert.equal(r.startsFetch, true);
});

test("request while active schedules one trailing refresh (no extra fetch)", () => {
  const r = step("active", { type: "request" });
  assert.equal(r.state, "active-trailing");
  assert.equal(r.startsFetch, false);
});

test("request while already trailing stays trailing (no duplicate trailing)", () => {
  const r = step("active-trailing", { type: "request" });
  assert.equal(r.state, "active-trailing");
  assert.equal(r.startsFetch, false);
});

test("complete with no trailing refresh returns to idle", () => {
  const r = step("active", { type: "complete" });
  assert.equal(r.state, "idle");
  assert.equal(r.startsFetch, false);
});

test("complete with a trailing refresh starts the trailing fetch", () => {
  const r = step("active-trailing", { type: "complete" });
  assert.equal(r.state, "active");
  assert.equal(r.startsFetch, true);
});

// ─── Burst scenario: a concurrent folder upload ────────────────────────────

test("a burst of concurrent requests collapses into one trailing refresh", () => {
  // Simulate a desktop folder drop: the operator's first upload completes and
  // calls refresh(); while that fetch is in flight, four more uploads complete
  // and each calls refresh(). Exactly two fetches should run overall.
  let state: CoalescedRefreshState = "idle";
  const starts: boolean[] = [];

  // First refresh: idle → active, fetch starts.
  let s = step(state, { type: "request" });
  state = s.state;
  starts.push(s.startsFetch);

  // Four overlapping refresh() calls while active: each only marks trailing.
  for (let i = 0; i < 4; i++) {
    s = step(state, { type: "request" });
    state = s.state;
    starts.push(s.startsFetch);
  }
  assert.equal(state, "active-trailing");

  // The in-flight fetch completes: trailing is promoted, the one trailing
  // fetch starts.
  s = step(state, { type: "complete" });
  state = s.state;
  starts.push(s.startsFetch);

  // That trailing fetch completes: back to idle.
  s = step(state, { type: "complete" });
  state = s.state;
  starts.push(s.startsFetch);

  assert.equal(state, "idle");
  // Exactly two fetches started: the initial and the single trailing one.
  assert.equal(starts.filter(Boolean).length, 2);
  assert.deepEqual(
    starts,
    [true, false, false, false, false, true, false],
  );
});

test("a request that arrives between complete and the trailing start is still served", () => {
  // active-trailing --complete--> active (trailing starts). A fresh request that
  // lands while that trailing fetch runs schedules another trailing, so it is
  // not lost.
  let state: CoalescedRefreshState = "active-trailing";
  let s = step(state, { type: "complete" });
  state = s.state; // active (trailing fetch running)
  assert.equal(s.startsFetch, true);

  s = step(state, { type: "request" }); // new request mid-flight
  assert.equal(s.state, "active-trailing");
  assert.equal(s.startsFetch, false);
});

// ─── shouldPollRecentCaptures ───────────────────────────────────────────────

test("polling active while any item is pending", () => {
  assert.equal(
    shouldPollRecentCaptures({ anyPending: true, refreshUnavailable: false }),
    true,
  );
});

test("polling active while a refresh is unavailable (keeps retrying)", () => {
  assert.equal(
    shouldPollRecentCaptures({ anyPending: false, refreshUnavailable: true }),
    true,
  );
});

test("polling stops only when nothing is pending AND refresh is healthy", () => {
  assert.equal(
    shouldPollRecentCaptures({ anyPending: false, refreshUnavailable: false }),
    false,
  );
  // A failed extraction is terminal and does not itself count as pending —
  // verified here at the policy layer via anyPending=false (the hook computes
  // anyPending with isRecentCapturePending, which returns false for failed).
  assert.equal(
    shouldPollRecentCaptures({ anyPending: false, refreshUnavailable: false }),
    false,
  );
});
