// Tests for the pure client-side snapshot validation helper.
import test from "node:test";
import assert from "node:assert/strict";
import { isValidSnapshot } from "@/components/receipts/sender-controls";

test("isValidSnapshot: complete snapshot accepted", () => {
  assert.equal(isValidSnapshot({ trusted: [], blocked: [], unrecognized: [] }), true);
  assert.equal(isValidSnapshot({ trusted: [{ email: "a@b.com" }], blocked: [], unrecognized: [] }), true);
});

test("isValidSnapshot: missing trusted → rejected", () => {
  assert.equal(isValidSnapshot({ blocked: [], unrecognized: [] }), false);
});

test("isValidSnapshot: missing blocked → rejected", () => {
  assert.equal(isValidSnapshot({ trusted: [], unrecognized: [] }), false);
});

test("isValidSnapshot: missing unrecognized → rejected", () => {
  assert.equal(isValidSnapshot({ trusted: [], blocked: [] }), false);
});

test("isValidSnapshot: malformed body (not object) → rejected", () => {
  assert.equal(isValidSnapshot(null), false);
  assert.equal(isValidSnapshot(undefined), false);
  assert.equal(isValidSnapshot("string"), false);
  assert.equal(isValidSnapshot(42), false);
});

test("isValidSnapshot: wrong types (not arrays) → rejected", () => {
  assert.equal(isValidSnapshot({ trusted: "x", blocked: [], unrecognized: [] }), false);
  assert.equal(isValidSnapshot({ trusted: [], blocked: null, unrecognized: [] }), false);
});

test("isValidSnapshot: empty object → rejected", () => {
  assert.equal(isValidSnapshot({}), false);
});
