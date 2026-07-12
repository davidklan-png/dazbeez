import test from "node:test";
import assert from "node:assert/strict";
import { parseAmexLinePatch } from "@/lib/receipts/api/amex-line-patch";

// Contract tests for PATCH /api/receipts/amex/lines/[id]. The route's DB
// layer uses `"key" in input` for nullable fields, so the parse helper MUST
// build a sparse input (only keys the request sent). An always-present key
// with undefined would NULL sibling columns on every save — the #67
// regression. These guard that contract without D1.

test("amex line PATCH: single field → sparse input that won't touch siblings (#67)", () => {
  const r = parseAmexLinePatch({ expenseCategory: "misc" });
  assert.ok(r.ok);
  assert.deepEqual(r.input, { expenseCategory: "misc" });
});

test("amex line PATCH: only expenseCategoryCode sent → only that key present", () => {
  const r = parseAmexLinePatch({ expenseCategoryCode: "supplies" });
  assert.ok(r.ok);
  assert.deepEqual(r.input, { expenseCategoryCode: "supplies" });
});

test("amex line PATCH: expenseCategoryCode empty string clears to null (key present)", () => {
  const r = parseAmexLinePatch({ expenseCategoryCode: "" });
  assert.ok(r.ok);
  assert.deepEqual(r.input, { expenseCategoryCode: null });
});

test("amex line PATCH: receiptMissingReason null clears (key present)", () => {
  const r = parseAmexLinePatch({ receiptMissingReason: null });
  assert.ok(r.ok);
  assert.deepEqual(r.input, { receiptMissingReason: null });
});

test("amex line PATCH: receiptMissingReason trimmed + sliced to 500 chars", () => {
  const r = parseAmexLinePatch({ receiptMissingReason: "  lost   " });
  assert.ok(r.ok);
  assert.equal(r.input.receiptMissingReason, "lost");

  const long = "x".repeat(600);
  const r2 = parseAmexLinePatch({ receiptMissingReason: long });
  assert.ok(r2.ok);
  assert.equal(r2.input.receiptMissingReason?.length, 500);
});

test("amex line PATCH: multiple fields all included", () => {
  const r = parseAmexLinePatch({
    expenseCategory: "misc",
    categoryStatus: "confirmed",
    receiptStatus: "matched",
  });
  assert.ok(r.ok);
  assert.deepEqual(r.input, {
    expenseCategory: "misc",
    categoryStatus: "confirmed",
    receiptStatus: "matched",
  });
});

test("amex line PATCH: invalid category code → error", () => {
  const r = parseAmexLinePatch({ expenseCategoryCode: "definitely-not-a-code" });
  assert.ok(!r.ok);
  assert.match(r.error, /Invalid expense category code/);
});

test("amex line PATCH: invalid enum → error", () => {
  const r = parseAmexLinePatch({ receiptStatus: "bogus_status" });
  assert.ok(!r.ok);
  assert.match(r.error, /Invalid receiptStatus/);
});

test("amex line PATCH: empty body → empty sparse input (no keys)", () => {
  const r = parseAmexLinePatch({});
  assert.ok(r.ok);
  assert.deepEqual(r.input, {});
});
