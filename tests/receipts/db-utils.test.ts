import test from "node:test";
import assert from "node:assert/strict";
import { D1_ID_CHUNK_SIZE } from "@/lib/receipts/db-utils";

test("D1_ID_CHUNK_SIZE: exactly 90, a positive integer, below 100 (bind headroom)", () => {
  assert.equal(D1_ID_CHUNK_SIZE, 90);
  assert.ok(
    Number.isInteger(D1_ID_CHUNK_SIZE) && D1_ID_CHUNK_SIZE > 0,
    "must be a positive integer",
  );
  // Stays below D1's ~100 bind-variable ceiling so queries that also bind a
  // few fixed values keep headroom.
  assert.ok(D1_ID_CHUNK_SIZE < 100, "must remain below 100");
});
