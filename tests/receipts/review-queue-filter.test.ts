import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewQueryParams,
  effectiveReviewMonth,
  ensureCurrentMonth,
  filterReviewQueue,
  resolveReviewMonthScope,
} from "@/lib/receipts/review-queue-filter";
import { currentCalendarMonth } from "@/lib/receipts/month-lock";
import type { ReceiptRecord } from "@/lib/receipts/types";

function receipt(partial: Partial<ReceiptRecord>): ReceiptRecord {
  return {
    id: "r1",
    payment_path: "CASH",
    status: "reviewed",
    transaction_date: "2026-07-10",
    business_purpose: "purpose",
    ...partial,
  } as ReceiptRecord;
}

// ─── filterReviewQueue: lock split is the default-hidden behavior ────────────

test("filterReviewQueue: default (no filter) excludes locked receipts", () => {
  const receipts = [
    receipt({ id: "free", status: "reviewed" }),
    receipt({ id: "sealed", status: "reviewed" }),
  ];
  const locks = new Map([
    ["free", { locked: false }],
    ["sealed", { locked: true }],
  ]);
  const out = filterReviewQueue(receipts, "", { locks });
  assert.deepEqual(out.map((r) => r.id), ["free"]);
});

test("filterReviewQueue: filter='locked' returns only locked receipts", () => {
  const receipts = [
    receipt({ id: "free", status: "reviewed" }),
    receipt({ id: "sealed", status: "reviewed" }),
    receipt({ id: "sealed2", status: "exported" }),
  ];
  const locks = new Map([
    ["free", { locked: false }],
    ["sealed", { locked: true }],
    ["sealed2", { locked: true }],
  ]);
  const out = filterReviewQueue(receipts, "locked", { locks });
  assert.deepEqual(out.map((r) => r.id).sort(), ["sealed", "sealed2"]);
});

test("filterReviewQueue: workflow filter ('needs') still hides locked", () => {
  const receipts = [
    receipt({ id: "free-need", status: "needs_review" }),
    receipt({ id: "sealed-need", status: "needs_review" }),
    receipt({ id: "free-rev", status: "reviewed" }),
  ];
  const locks = new Map([
    ["free-need", { locked: false }],
    ["sealed-need", { locked: true }],
    ["free-rev", { locked: false }],
  ]);
  const out = filterReviewQueue(receipts, "needs", { locks });
  assert.deepEqual(out.map((r) => r.id), ["free-need"]);
});

test("filterReviewQueue: status + payment_path deep-link filters compose with the lock split", () => {
  const receipts = [
    receipt({ id: "a", status: "captured", payment_path: "CASH" }),
    receipt({ id: "b", status: "captured", payment_path: "AMEX" }),
  ];
  const locks = new Map([
    ["a", { locked: false }],
    ["b", { locked: false }],
  ]);
  const out = filterReviewQueue(receipts, "", {
    statusFilter: "captured",
    paymentPathFilter: "AMEX",
    locks,
  });
  assert.deepEqual(out.map((r) => r.id), ["b"]);
});

// ─── resolveReviewMonthScope ─────────────────────────────────────────────────

test("resolveReviewMonthScope: 'all' → no month scope, undated not specially included", () => {
  const out = resolveReviewMonthScope("all");
  assert.equal(out.month, undefined);
  assert.equal(out.includeUndated, false);
});

test("resolveReviewMonthScope: a valid YYYY-MM → that month, undated included", () => {
  const out = resolveReviewMonthScope("2026-06");
  assert.equal(out.month, "2026-06");
  assert.equal(out.includeUndated, true);
});

test("resolveReviewMonthScope: absent → defaults to current calendar month, undated included", () => {
  const out = resolveReviewMonthScope(undefined);
  assert.equal(out.month, currentCalendarMonth());
  assert.equal(out.includeUndated, true);
});

test("resolveReviewMonthScope: malformed → ignored, defaults to current month", () => {
  const out = resolveReviewMonthScope("2026-6");
  assert.equal(out.month, currentCalendarMonth());
  assert.equal(out.includeUndated, true);
});

// ─── buildReviewQueryParams ──────────────────────────────────────────────────

test("buildReviewQueryParams: preserves filter + month + status + payment_path", () => {
  const out = buildReviewQueryParams(
    { filter: "needs", month: "2026-06", status: "needs_review", payment_path: "AMEX" },
    "2026-06",
  );
  assert.equal(out, "?filter=needs&month=2026-06&status=needs_review&payment_path=AMEX");
});

test("buildReviewQueryParams: monthParam '' (default) omits month so navigation stays on the default month", () => {
  const out = buildReviewQueryParams({ filter: "needs" }, "");
  assert.equal(out, "?filter=needs");
});

test("buildReviewQueryParams: no params → bare", () => {
  assert.equal(buildReviewQueryParams({}, ""), "");
});

// ─── effectiveReviewMonth / ensureCurrentMonth ───────────────────────────────

test("effectiveReviewMonth: 'all' → 'all'; a scope → the scope; default → current month", () => {
  assert.equal(effectiveReviewMonth("all", undefined), "all");
  assert.equal(effectiveReviewMonth("2026-06", "2026-06"), "2026-06");
  assert.equal(effectiveReviewMonth("", undefined), currentCalendarMonth());
});

test("ensureCurrentMonth: adds the current month if it isn't present; 'all' passes through", () => {
  assert.deepEqual(ensureCurrentMonth(["2026-05", "2026-04"], "2026-05"), ["2026-05", "2026-04"]);
  assert.deepEqual(ensureCurrentMonth(["2026-05"], "2026-06"), ["2026-06", "2026-05"]);
  assert.deepEqual(ensureCurrentMonth(["2026-05"], "all"), ["2026-05"]);
});
