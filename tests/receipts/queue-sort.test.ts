import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SORT,
  needsFirst,
  sortQueueItems,
  type SortKey,
} from "@/lib/receipts/queue-sort";
import type { QueueItem } from "@/lib/receipts/queue-items";

function item(partial: Partial<QueueItem> & Pick<QueueItem, "id">): QueueItem {
  return {
    merchant: "Acme",
    amountLabel: "¥1,000",
    dateLabel: "Jul 1",
    categoryLabel: "Transportation",
    status: "reviewed",
    needs: null,
    stuck: false,
    extractionFailed: false,
    failureReason: null,
    locked: false,
    lockKind: null,
    sortDateMs: Date.UTC(2026, 6, 1),
    sortAmountMinor: 1000,
    ...partial,
  };
}

// ─── needsFirst predicate ────────────────────────────────────────────────────

test("needsFirst: false for a clean reviewed row", () => {
  assert.equal(needsFirst(item({ id: "a" })), false);
});

test("needsFirst: true when needs is set, stuck, OR extractionFailed", () => {
  assert.equal(needsFirst(item({ id: "a", needs: "attendees" })), true);
  assert.equal(needsFirst(item({ id: "a", stuck: true })), true);
  assert.equal(needsFirst(item({ id: "a", extractionFailed: true })), true);
});

// ─── sortQueueItems ─────────────────────────────────────────────────────────

test("sortQueueItems: does not mutate the input array", () => {
  const items = [item({ id: "b", sortAmountMinor: 200 }), item({ id: "a", sortAmountMinor: 100 })];
  const snapshot = items.map((i) => i.id);
  sortQueueItems(items, "amount-desc");
  assert.deepEqual(items.map((i) => i.id), snapshot, "input order preserved");
});

test("sortQueueItems: amount-desc by sortAmountMinor", () => {
  const items = [
    item({ id: "small", sortAmountMinor: 100 }),
    item({ id: "big", sortAmountMinor: 9999 }),
    item({ id: "mid", sortAmountMinor: 500 }),
  ];
  const out = sortQueueItems(items, "amount-desc");
  assert.deepEqual(out.map((i) => i.id), ["big", "mid", "small"]);
});

test("sortQueueItems: date-desc / date-asc by sortDateMs", () => {
  const items = [
    item({ id: "old", sortDateMs: Date.UTC(2026, 0, 1) }),
    item({ id: "new", sortDateMs: Date.UTC(2026, 11, 31) }),
  ];
  assert.deepEqual(sortQueueItems(items, "date-desc").map((i) => i.id), ["new", "old"]);
  assert.deepEqual(sortQueueItems(items, "date-asc").map((i) => i.id), ["old", "new"]);
});

test("sortQueueItems: merchant-az is case-insensitive alpha", () => {
  const items = [
    item({ id: "b", merchant: "banana" }),
    item({ id: "a", merchant: "Apple" }),
  ];
  const out = sortQueueItems(items, "merchant-az");
  assert.deepEqual(out.map((i) => i.id), ["a", "b"]);
});

test("sortQueueItems: 'needs' surfaces needs/stuck/failed before reviewed, date-desc within each group", () => {
  const items = [
    item({ id: "rev-old", sortDateMs: 1 }),
    item({ id: "need-new", needs: "attendees", sortDateMs: 100 }),
    item({ id: "need-old", needs: "purpose", sortDateMs: 50 }),
    item({ id: "rev-new", sortDateMs: 90 }),
  ];
  const out = sortQueueItems(items, "needs");
  // Needs group first, date-desc within it; then reviewed group, date-desc.
  assert.deepEqual(out.map((i) => i.id), ["need-new", "need-old", "rev-new", "rev-old"]);
});

// ─── undated last (review-closing-scope default sort) ───────────────────────

test("sortQueueItems: date-asc puts undated/legacy rows (sortDateMs 0) LAST, not ahead of real dates", () => {
  const items = [
    item({ id: "undated", sortDateMs: 0 }),
    item({ id: "mid", sortDateMs: Date.UTC(2026, 6, 15) }),
    item({ id: "early", sortDateMs: Date.UTC(2026, 6, 1) }),
    item({ id: "also-undated", sortDateMs: 0 }),
  ];
  const out = sortQueueItems(items, "date-asc");
  assert.deepEqual(out.map((i) => i.id), ["early", "mid", "undated", "also-undated"]);
});

test("sortQueueItems: date-desc also keeps undated rows last", () => {
  const items = [
    item({ id: "undated", sortDateMs: 0 }),
    item({ id: "early", sortDateMs: Date.UTC(2026, 6, 1) }),
    item({ id: "late", sortDateMs: Date.UTC(2026, 6, 20) }),
  ];
  const out = sortQueueItems(items, "date-desc");
  assert.deepEqual(out.map((i) => i.id), ["late", "early", "undated"]);
});

test("DEFAULT_SORT is 'date-asc' (earliest transaction/capture date first)", () => {
  assert.equal(DEFAULT_SORT, "date-asc" as SortKey);
});
