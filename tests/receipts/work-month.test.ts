import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidWorkMonth,
  resolveWorkMonth,
  withWorkMonth,
} from "@/lib/receipts/work-month";

// ─── isValidWorkMonth (type guard + exactness) ──────────────────────────────

test("isValidWorkMonth: true only for exact YYYY-MM", () => {
  assert.equal(isValidWorkMonth("2026-06"), true);
  assert.equal(isValidWorkMonth("2026-12"), true);
  assert.equal(isValidWorkMonth("0001-01"), true);
});

test("isValidWorkMonth: rejects all/malformed/missing", () => {
  // The review queue's recent-window sentinel — must never be propagated.
  assert.equal(isValidWorkMonth("all"), false);
  // Malformed.
  assert.equal(isValidWorkMonth("2026-6"), false);
  assert.equal(isValidWorkMonth("2026"), false);
  assert.equal(isValidWorkMonth("2026-06-01"), false);
  assert.equal(isValidWorkMonth("26-06"), false);
  assert.equal(isValidWorkMonth("2026/06"), false);
  assert.equal(isValidWorkMonth(" 2026-06"), false);
  // Missing / wrong type.
  assert.equal(isValidWorkMonth(""), false);
  assert.equal(isValidWorkMonth(null), false);
  assert.equal(isValidWorkMonth(undefined), false);
});

test("isValidWorkMonth narrows the type", () => {
  const raw: string | null | undefined = "2026-06";
  if (isValidWorkMonth(raw)) {
    // `raw` is now `string` — assignment proves the guard narrowed it.
    const m: string = raw;
    assert.equal(m, "2026-06");
  } else {
    assert.fail("should have validated");
  }
});

// ─── resolveWorkMonth ───────────────────────────────────────────────────────

test("resolveWorkMonth: returns the value when valid, else null", () => {
  assert.equal(resolveWorkMonth("2026-06"), "2026-06");
  assert.equal(resolveWorkMonth("all"), null);
  assert.equal(resolveWorkMonth("2026-6"), null);
  assert.equal(resolveWorkMonth(""), null);
  assert.equal(resolveWorkMonth(null), null);
  assert.equal(resolveWorkMonth(undefined), null);
});

// ─── withWorkMonth (href construction) ──────────────────────────────────────

test("withWorkMonth: bare path when there is no valid month", () => {
  assert.equal(withWorkMonth("/receipts/review", null), "/receipts/review");
  assert.equal(withWorkMonth("/receipts/review", undefined), "/receipts/review");
  assert.equal(withWorkMonth("/receipts/review", "all"), "/receipts/review");
  assert.equal(withWorkMonth("/receipts/review", "2026-6"), "/receipts/review");
  assert.equal(withWorkMonth("/receipts/review", ""), "/receipts/review");
});

test("withWorkMonth: appends ?month= for a bare path", () => {
  assert.equal(
    withWorkMonth("/receipts/reconcile", "2026-06"),
    "/receipts/reconcile?month=2026-06",
  );
});

test("withWorkMonth: uses & when the path already has a query string", () => {
  // Shortcut links keep their own params and gain the month.
  assert.equal(
    withWorkMonth("/receipts/capture?payment=CASH", "2026-06"),
    "/receipts/capture?payment=CASH&month=2026-06",
  );
  assert.equal(
    withWorkMonth("/receipts/capture?mode=rapid", "2026-06"),
    "/receipts/capture?mode=rapid&month=2026-06",
  );
});

test("withWorkMonth: never leaks month=all into the href", () => {
  assert.equal(withWorkMonth("/receipts/export", "all"), "/receipts/export");
  assert.equal(
    withWorkMonth("/receipts/capture?payment=CASH", "all"),
    "/receipts/capture?payment=CASH",
  );
});

test("withWorkMonth: invalid input never propagated even with existing query", () => {
  assert.equal(
    withWorkMonth("/receipts/capture?mode=rapid", "2026-6"),
    "/receipts/capture?mode=rapid",
  );
  assert.equal(
    withWorkMonth("/receipts/capture?mode=rapid", "garbage"),
    "/receipts/capture?mode=rapid",
  );
});

test("withWorkMonth: month validity is shape-only — an impossible-but-well-shaped month still propagates", () => {
  // The carry rule blocks only `all`/malformed/empty; range validity (e.g.
  // month 13) is the destination page's concern, not the propagation rule's.
  // The destinations all use the same `/^\d{4}-\d{2}$/` shape check, so a
  // well-shaped-but-impossible value is handled identically on both sides.
  assert.equal(
    withWorkMonth("/r", "2026-13"),
    "/r?month=2026-13",
  );
});
