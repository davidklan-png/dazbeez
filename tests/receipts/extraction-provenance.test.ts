import assert from "node:assert/strict";
import test from "node:test";
import { coerceSourcePageCount } from "@/lib/receipts/extraction";

test("source page count accepts positive safe integers", () => {
  assert.equal(coerceSourcePageCount(1), 1);
  assert.equal(coerceSourcePageCount(2), 2);
  assert.equal(coerceSourcePageCount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("source page count rejects malformed or unsafe provenance", () => {
  for (const value of [
    undefined,
    null,
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "2",
  ]) {
    assert.equal(coerceSourcePageCount(value), undefined);
  }
});
