import test from "node:test";
import assert from "node:assert/strict";
import { shouldOverwriteMerchant } from "@/lib/receipts/reconciliation";

// ─── shouldOverwriteMerchant ─────────────────────────────────────────────────

test("both filled, same normalized form → false", () => {
  assert.equal(shouldOverwriteMerchant("AMAZON", "Amazon"), false);
});

test("both filled, different forms → true", () => {
  assert.equal(shouldOverwriteMerchant("AMAZON.CO.JP", "Amazon Marketplace"), true);
});

test("both filled, exact same string → false", () => {
  assert.equal(shouldOverwriteMerchant("STARBUCKS", "STARBUCKS"), false);
});

test("amexMerchant null → false", () => {
  assert.equal(shouldOverwriteMerchant(null, "Amazon"), false);
});

test("receiptMerchant null → false", () => {
  assert.equal(shouldOverwriteMerchant("Amazon", null), false);
});

test("both null → false", () => {
  assert.equal(shouldOverwriteMerchant(null, null), false);
});

test("empty string treated as null → false", () => {
  assert.equal(shouldOverwriteMerchant("", "Amazon"), false);
  assert.equal(shouldOverwriteMerchant("Amazon", ""), false);
});
