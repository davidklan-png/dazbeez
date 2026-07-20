import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewControlQuery,
  buildReviewQueryParams,
  closingToggleMonth,
  effectiveReviewMonth,
  ensureCurrentMonth,
  filterReviewQueue,
  isConcreteMonth,
  mergeMonthOptions,
  normalizeReviewFilter,
  parseReviewScope,
  resolveReviewMonthScope,
  resolveReviewScope,
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

const UNLOCKED: { locked: boolean } = { locked: false };
const LOCKED: { locked: boolean } = { locked: true };

// ─── filterReviewQueue: tabs ────────────────────────────────────────────────

test("filterReviewQueue: All (default) returns unlocked receipts, excludes locked", () => {
  const receipts = [
    receipt({ id: "free", payment_path: "CASH" }),
    receipt({ id: "sealed", payment_path: "CASH" }),
  ];
  const locks = new Map([
    ["free", UNLOCKED],
    ["sealed", LOCKED],
  ]);
  const out = filterReviewQueue(receipts, "", { locks });
  assert.deepEqual(out.map((r) => r.id), ["free"]);
});

test("filterReviewQueue: Locked returns only locked receipts", () => {
  const receipts = [
    receipt({ id: "free" }),
    receipt({ id: "sealed" }),
    receipt({ id: "sealed2", status: "exported" }),
  ];
  const locks = new Map([
    ["free", UNLOCKED],
    ["sealed", LOCKED],
    ["sealed2", LOCKED],
  ]);
  const out = filterReviewQueue(receipts, "locked", { locks });
  assert.deepEqual(out.map((r) => r.id).sort(), ["sealed", "sealed2"]);
});

test("filterReviewQueue: Needs review consumes the supplied attention-ID set (locked excluded)", () => {
  const receipts = [
    receipt({ id: "att" }),
    receipt({ id: "clean" }),
    receipt({ id: "att-locked" }),
  ];
  const locks = new Map([
    ["att", UNLOCKED],
    ["clean", UNLOCKED],
    ["att-locked", LOCKED],
  ]);
  const attentionIds = new Set(["att", "att-locked"]);
  const out = filterReviewQueue(receipts, "needs", { locks, attentionIds });
  // att-locked is in the attention set but locked → excluded.
  assert.deepEqual(out.map((r) => r.id), ["att"]);
});

test("filterReviewQueue: AMEX / Non-AMEX partition the unlocked set (calendar scope = payment_path)", () => {
  const receipts = [
    receipt({ id: "amex", payment_path: "AMEX" }),
    receipt({ id: "cash", payment_path: "CASH" }),
    receipt({ id: "unknown", payment_path: "UNKNOWN" }),
  ];
  const locks = new Map([
    ["amex", UNLOCKED],
    ["cash", UNLOCKED],
    ["unknown", UNLOCKED],
  ]);
  const amex = filterReviewQueue(receipts, "amex", { locks, scope: "calendar" });
  const nonAmex = filterReviewQueue(receipts, "non-amex", { locks, scope: "calendar" });
  assert.deepEqual(amex.map((r) => r.id), ["amex"]);
  assert.deepEqual(nonAmex.map((r) => r.id).sort(), ["cash", "unknown"]);
});

test("filterReviewQueue: AMEX / Non-AMEX in closing scope partition by amexMatchedIds", () => {
  // A CASH-path receipt that is nonetheless matched to the statement's AMEX
  // line appears under AMEX in closing scope; the rest are Non-AMEX.
  const receipts = [
    receipt({ id: "matched", payment_path: "CASH" }),
    receipt({ id: "assigned", payment_path: "CASH" }),
    receipt({ id: "unknown", payment_path: "UNKNOWN" }),
  ];
  const locks = new Map([
    ["matched", UNLOCKED],
    ["assigned", UNLOCKED],
    ["unknown", UNLOCKED],
  ]);
  const amexMatchedIds = new Set(["matched"]);
  const amex = filterReviewQueue(receipts, "amex", { locks, scope: "closing", amexMatchedIds });
  const nonAmex = filterReviewQueue(receipts, "non-amex", { locks, scope: "closing", amexMatchedIds });
  assert.deepEqual(amex.map((r) => r.id), ["matched"]);
  assert.deepEqual(nonAmex.map((r) => r.id).sort(), ["assigned", "unknown"]);
});

test("filterReviewQueue: legacy keys (attendees/purpose/reviewed) + unknown fall back to All", () => {
  const receipts = [
    receipt({ id: "a", status: "reviewed" }),
    receipt({ id: "b", status: "needs_review" }),
  ];
  const locks = new Map([
    ["a", UNLOCKED],
    ["b", UNLOCKED],
  ]);
  for (const key of ["attendees", "purpose", "reviewed", "nonsense"]) {
    const out = filterReviewQueue(receipts, key, { locks });
    assert.deepEqual(out.map((r) => r.id).sort(), ["a", "b"], `filter=${key} should fall back to All`);
  }
});

test("filterReviewQueue: status + payment_path deep-link filters compose with the lock split", () => {
  const receipts = [
    receipt({ id: "a", status: "captured", payment_path: "CASH" }),
    receipt({ id: "b", status: "captured", payment_path: "AMEX" }),
  ];
  const locks = new Map([
    ["a", UNLOCKED],
    ["b", UNLOCKED],
  ]);
  const out = filterReviewQueue(receipts, "", {
    statusFilter: "captured",
    paymentPathFilter: "AMEX",
    locks,
  });
  assert.deepEqual(out.map((r) => r.id), ["b"]);
});

// ─── scope parsing / resolution ─────────────────────────────────────────────

test("parseReviewScope: 'closing' → closing; everything else → calendar", () => {
  assert.equal(parseReviewScope("closing"), "closing");
  assert.equal(parseReviewScope(undefined), "calendar");
  assert.equal(parseReviewScope("calendar"), "calendar");
  assert.equal(parseReviewScope("garbage"), "calendar");
});

test("resolveReviewScope: closing is honored only for a concrete YYYY-MM; 'all'/default → calendar", () => {
  assert.equal(resolveReviewScope("closing", "2026-07"), "closing");
  assert.equal(resolveReviewScope("closing", "all"), "calendar");
  assert.equal(resolveReviewScope("closing", ""), "calendar");
  assert.equal(resolveReviewScope(undefined, "2026-07"), "calendar");
});

test("isConcreteMonth: only YYYY-MM", () => {
  assert.equal(isConcreteMonth("2026-07"), true);
  assert.equal(isConcreteMonth(""), false);
  assert.equal(isConcreteMonth("all"), false);
  assert.equal(isConcreteMonth("2026-7"), false);
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

// ─── buildReviewQueryParams (now preserves scope) ───────────────────────────

test("buildReviewQueryParams: preserves filter + month + scope + status + payment_path", () => {
  const out = buildReviewQueryParams(
    { filter: "needs", month: "2026-06", scope: "closing", status: "needs_review", payment_path: "AMEX" },
    "2026-06",
    "closing",
  );
  assert.equal(out, "?filter=needs&month=2026-06&scope=closing&status=needs_review&payment_path=AMEX");
});

test("buildReviewQueryParams: scope=closing dropped when month is 'all'", () => {
  const out = buildReviewQueryParams({ filter: "needs", scope: "closing" }, "all", "closing");
  // No scope in the output because 'all' has no closing scope.
  assert.equal(out, "?filter=needs&month=all");
  assert.ok(!out.includes("scope"));
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

// ─── mergeMonthOptions (picker union) ────────────────────────────────────────

test("mergeMonthOptions: unions receipt months + AMEX statement months + effective month, deduped, newest first", () => {
  const out = mergeMonthOptions(["2026-06", "2026-04"], ["2026-07", "2026-06"], "2026-05");
  assert.deepEqual(out, ["2026-07", "2026-06", "2026-05", "2026-04"]);
});

test("mergeMonthOptions: 'all' effective month is not added as an option", () => {
  const out = mergeMonthOptions(["2026-06"], [], "all");
  assert.deepEqual(out, ["2026-06"]);
});

// ─── closing-scope toggle: implicit vs explicit month ───────────────────────

test("closingToggleMonth: implicit month ('') resolves to the effective (current) month", () => {
  assert.equal(closingToggleMonth("", "2026-07"), "2026-07");
});

test("closingToggleMonth: explicit month wins over the effective month", () => {
  assert.equal(closingToggleMonth("2026-06", "2026-07"), "2026-06");
});

test("closingToggleMonth: All months stays 'all'", () => {
  assert.equal(closingToggleMonth("all", "all"), "all");
});

test("closing scope: enabling from the default/implicit current month produces ?month=YYYY-MM&scope=closing", () => {
  // monthParam '' but the selector shows effectiveMonth 2026-07 → the toggle
  // must be enabled and navigate with an explicit month.
  const month = closingToggleMonth("", "2026-07");
  assert.equal(isConcreteMonth(month), true);
  assert.equal(
    buildReviewControlQuery({ month, filter: null, scope: "closing" }),
    "?month=2026-07&scope=closing",
  );
});

test("closing scope: explicit month is unchanged when enabling (filter preserved)", () => {
  const month = closingToggleMonth("2026-06", "2026-07");
  assert.equal(month, "2026-06");
  assert.equal(
    buildReviewControlQuery({ month, filter: "needs", scope: "closing" }),
    "?month=2026-06&filter=needs&scope=closing",
  );
});

test("closing scope: All months cannot enable closing scope (toggle disabled, scope dropped)", () => {
  const month = closingToggleMonth("all", "all");
  assert.equal(isConcreteMonth(month), false);
  // buildReviewControlQuery never emits scope=closing for a non-concrete month.
  assert.equal(
    buildReviewControlQuery({ month: "all", filter: null, scope: "closing" }),
    "?month=all",
  );
});

test("closing scope: disabling preserves the concrete month and drops scope", () => {
  // Once enabled, the URL carries the explicit month; disabling keeps it.
  const month = closingToggleMonth("2026-06", "2026-07");
  assert.equal(
    buildReviewControlQuery({ month, filter: null, scope: "calendar" }),
    "?month=2026-06",
  );
});

// ─── normalizeReviewFilter (visible active tab) ─────────────────────────────

test("normalizeReviewFilter: recognized keys pass through", () => {
  assert.equal(normalizeReviewFilter("needs"), "needs");
  assert.equal(normalizeReviewFilter("amex"), "amex");
  assert.equal(normalizeReviewFilter("non-amex"), "non-amex");
  assert.equal(normalizeReviewFilter("locked"), "locked");
});

test("normalizeReviewFilter: legacy + unknown keys normalize to All ('')", () => {
  for (const key of ["attendees", "purpose", "reviewed", "nonsense"]) {
    assert.equal(normalizeReviewFilter(key), "", `key=${key} should normalize to All`);
  }
  assert.equal(normalizeReviewFilter(""), "");
  assert.equal(normalizeReviewFilter(null), "");
  assert.equal(normalizeReviewFilter(undefined), "");
});

