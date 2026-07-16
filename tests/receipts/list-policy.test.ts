import test from "node:test";
import assert from "node:assert/strict";
import { RECEIPT_BULK_LIMIT, RECEIPT_VIEW_LIMIT, hasReceiptBulkOverflow } from "@/lib/receipts/list-policy";

test("RECEIPT_VIEW_LIMIT is exactly 200", () => {
  assert.equal(RECEIPT_VIEW_LIMIT, 200);
});

test("RECEIPT_BULK_LIMIT is exactly 1000", () => {
  assert.equal(RECEIPT_BULK_LIMIT, 1000);
});

test("RECEIPT_BULK_LIMIT is greater than RECEIPT_VIEW_LIMIT (distinct semantics)", () => {
  assert.ok(
    RECEIPT_BULK_LIMIT > RECEIPT_VIEW_LIMIT,
    "bulk limit must remain the larger, intentionally distinct ceiling",
  );
});

test("hasReceiptBulkOverflow: false below and at the limit, true above", () => {
  assert.equal(hasReceiptBulkOverflow(RECEIPT_BULK_LIMIT - 1), false); // 999
  assert.equal(hasReceiptBulkOverflow(RECEIPT_BULK_LIMIT), false);     // 1000
  assert.equal(hasReceiptBulkOverflow(RECEIPT_BULK_LIMIT + 1), true);  // 1001
});
