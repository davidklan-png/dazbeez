// Tests for the remaining read/normalize helpers in trusted-senders.ts.
// Mutation tests (trust/block/untrust/unblock) live in sender-policy.test.ts
// (mutations were consolidated into the policy module for mutual exclusion).

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSenderEmail,
  isValidSenderEmail,
} from "@/lib/receipts/trusted-senders";

test("normalizeSenderEmail: trims + lowercases", () => {
  assert.equal(normalizeSenderEmail("  David@Gmail.com  "), "david@gmail.com");
  assert.equal(normalizeSenderEmail("FOO@BAR.COM"), "foo@bar.com");
});

test("isValidSenderEmail: accepts valid, rejects malformed", () => {
  assert.equal(isValidSenderEmail("david@gmail.com"), true);
  assert.equal(isValidSenderEmail("  David@Gmail.com  "), true);
  assert.equal(isValidSenderEmail("not-an-email"), false);
  assert.equal(isValidSenderEmail("missing@tld"), false);
  assert.equal(isValidSenderEmail(""), false);
  assert.equal(isValidSenderEmail("spaces in@email.com"), false);
});
