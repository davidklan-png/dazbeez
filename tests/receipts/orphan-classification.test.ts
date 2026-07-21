import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyUnmatchedReceipt,
  partitionUnmatchedReceipts,
  statementLineDateRange,
} from "@/lib/receipts/orphan-classification";

const RANGE = { minDate: "2026-06-10", maxDate: "2026-07-10" };
const dated = (transaction_date: string) => ({ transaction_date });
const undated = () => ({ transaction_date: null });

// ─── classifyUnmatchedReceipt: boundaries ────────────────────────────────────

test("date on first line date is in-period (inclusive lower bound)", () => {
  assert.equal(classifyUnmatchedReceipt(dated("2026-06-10"), RANGE), "true_in_period");
});

test("date on last line date is in-period (inclusive upper bound)", () => {
  assert.equal(classifyUnmatchedReceipt(dated("2026-07-10"), RANGE), "true_in_period");
});

test("date strictly inside the range is in-period", () => {
  assert.equal(classifyUnmatchedReceipt(dated("2026-06-29"), RANGE), "true_in_period");
});

test("date before min (leading pad) is leading_slack, NOT an orphan", () => {
  assert.equal(classifyUnmatchedReceipt(dated("2026-06-09"), RANGE), "leading_slack");
  assert.equal(classifyUnmatchedReceipt(dated("2026-06-05"), RANGE), "leading_slack");
});

test("date after max is upcoming / awaiting next statement", () => {
  assert.equal(classifyUnmatchedReceipt(dated("2026-07-11"), RANGE), "upcoming");
  assert.equal(classifyUnmatchedReceipt(dated("2026-07-14"), RANGE), "upcoming");
});

test("null transaction_date is undated / needs date", () => {
  assert.equal(classifyUnmatchedReceipt(undated(), RANGE), "undated");
});

// ─── empty-line fallback (no statement dates) ────────────────────────────────

test("empty-line fallback: dated receipts become upcoming, undated stay undated", () => {
  const empty = { minDate: null, maxDate: null };
  assert.equal(classifyUnmatchedReceipt(dated("2026-06-10"), empty), "upcoming");
  assert.equal(classifyUnmatchedReceipt(dated("2025-01-01"), empty), "upcoming");
  assert.equal(classifyUnmatchedReceipt(undated(), empty), "undated");
});

// ─── statementLineDateRange ──────────────────────────────────────────────────

test("statementLineDateRange ignores nulls and returns min/max", () => {
  assert.deepEqual(
    statementLineDateRange(["2026-07-06", null, "2026-05-05", undefined, "2026-06-01"]),
    { minDate: "2026-05-05", maxDate: "2026-07-06" },
  );
});

test("statementLineDateRange returns null/null when no dated lines", () => {
  assert.deepEqual(statementLineDateRange([null, undefined]), { minDate: null, maxDate: null });
  assert.deepEqual(statementLineDateRange([]), { minDate: null, maxDate: null });
});

// ─── partitionUnmatchedReceipts ──────────────────────────────────────────────

test("partition splits into the four classes; only true_in_period are orphans", () => {
  const receipts = [
    dated("2026-06-10"), // in-period (min boundary)
    dated("2026-07-02"), // in-period
    dated("2026-06-06"), // leading slack
    dated("2026-07-14"), // upcoming
    undated(),           // undated
  ];
  const p = partitionUnmatchedReceipts(receipts, RANGE);
  assert.equal(p.true_in_period.length, 2);
  assert.equal(p.leading_slack.length, 1);
  assert.equal(p.upcoming.length, 1);
  assert.equal(p.undated.length, 1);
});

test("partition preserves element identity (generic over the input type)", () => {
  const receipts = [{ id: "a", transaction_date: "2026-07-01" }, { id: "b", transaction_date: null }] as Array<{ id: string; transaction_date: string | null }>;
  const p = partitionUnmatchedReceipts(receipts, RANGE);
  assert.equal(p.true_in_period[0]!.id, "a");
  assert.equal(p.undated[0]!.id, "b");
});
