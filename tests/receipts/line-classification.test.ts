import test from "node:test";
import assert from "node:assert/strict";
import { resolveLineCategory } from "@/lib/receipts/line-classification";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

function makeLine(
  overrides: Partial<Pick<AmexStatementLine, "matched_receipt_id" | "expense_category_code">> = {},
) {
  return {
    matched_receipt_id: null,
    expense_category_code: null,
    ...overrides,
  };
}

function makeReceipt(
  overrides: Partial<Pick<ReceiptRecord, "expense_category_code" | "deleted_at">> = {},
) {
  return {
    expense_category_code: null,
    deleted_at: null,
    ...overrides,
  };
}

test("resolveLineCategory: no matched receipt → line value wins", () => {
  const line = makeLine({ expense_category_code: "office_supplies" });
  assert.equal(resolveLineCategory(line, undefined), "office_supplies");
});

test("resolveLineCategory: no matched receipt, line category null → null", () => {
  const line = makeLine({ expense_category_code: null });
  assert.equal(resolveLineCategory(line, undefined), null);
});

test("resolveLineCategory: matched receipt exists → receipt value wins", () => {
  const line = makeLine({
    matched_receipt_id: "r-1",
    expense_category_code: "office_supplies",
  });
  const receipt = makeReceipt({ expense_category_code: "meeting" });
  assert.equal(resolveLineCategory(line, receipt), "meeting");
});

test("resolveLineCategory: matched receipt wins even when line category is null (UI dead-end fix)", () => {
  // This is the case the architect flagged: receipt-linked line with null
  // line-category and a categorized receipt. Pre-fix this returned null and
  // blocked export/signoff. Post-fix it returns the receipt's category.
  const line = makeLine({
    matched_receipt_id: "r-1",
    expense_category_code: null,
  });
  const receipt = makeReceipt({ expense_category_code: "meeting" });
  assert.equal(resolveLineCategory(line, receipt), "meeting");
});

test("resolveLineCategory: matched receipt with null category → null wins over line value", () => {
  // When the receipt exists but has no category, the receipt is still the
  // system of record — the line value is NOT consulted. This forces the
  // user to set the category on the receipt (the system of record), not
  // silently inherit a stale line value.
  const line = makeLine({
    matched_receipt_id: "r-1",
    expense_category_code: "office_supplies",
  });
  const receipt = makeReceipt({ expense_category_code: null });
  assert.equal(resolveLineCategory(line, receipt), null);
});

test("resolveLineCategory: dangling match (matched_receipt_id set, receipt undefined) → line fallback", () => {
  // receipt_id set but receipt was deleted out-of-band and isn't in the map.
  // Don't invent a new error — fall back to line so the operator still sees
  // something actionable.
  const line = makeLine({
    matched_receipt_id: "r-missing",
    expense_category_code: "office_supplies",
  });
  assert.equal(resolveLineCategory(line, undefined), "office_supplies");
});

test("resolveLineCategory: soft-deleted receipt → line fallback", () => {
  // listReceiptRecordsByIds filters deleted_at IS NULL upstream so this case
  // is unlikely in the API paths, but the helper is defensive — a deleted
  // receipt must not win.
  const line = makeLine({
    matched_receipt_id: "r-1",
    expense_category_code: "office_supplies",
  });
  const receipt = makeReceipt({
    expense_category_code: "meeting",
    deleted_at: "2026-07-01T00:00:00Z",
  });
  assert.equal(resolveLineCategory(line, receipt), "office_supplies");
});

test("resolveLineCategory: null receipt argument → line fallback", () => {
  const line = makeLine({ expense_category_code: "office_supplies" });
  assert.equal(resolveLineCategory(line, null), "office_supplies");
});
