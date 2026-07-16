import test from "node:test";
import assert from "node:assert/strict";
import {
  D1_ID_CHUNK_FIXED_BIND_HEADROOM,
  D1_ID_CHUNK_SIZE,
  D1_MAX_BOUND_PARAMS,
} from "@/lib/receipts/db-utils";

test("D1 bind-budget policy: values, positivity, and invariant", () => {
  assert.equal(D1_MAX_BOUND_PARAMS, 100);
  assert.equal(D1_ID_CHUNK_FIXED_BIND_HEADROOM, 10);
  assert.equal(D1_ID_CHUNK_SIZE, 90);
  for (const v of [D1_MAX_BOUND_PARAMS, D1_ID_CHUNK_FIXED_BIND_HEADROOM, D1_ID_CHUNK_SIZE]) {
    assert.ok(Number.isInteger(v) && v > 0, `${v} must be a positive integer`);
  }
  assert.equal(
    D1_ID_CHUNK_SIZE + D1_ID_CHUNK_FIXED_BIND_HEADROOM,
    D1_MAX_BOUND_PARAMS,
  );
});
