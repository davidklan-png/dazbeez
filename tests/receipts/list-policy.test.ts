import test from "node:test";
import assert from "node:assert/strict";
import { RECEIPT_BULK_LIMIT, RECEIPT_VIEW_LIMIT } from "@/lib/receipts/list-policy";

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
