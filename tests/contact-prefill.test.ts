import test from "node:test";
import assert from "node:assert/strict";
import { CONTACT_MESSAGE_MAX_LENGTH, normalizeMessagePrefill } from "@/lib/contact-prefill";

test("normalizeMessagePrefill returns a normal English message unchanged", () => {
  const msg = "Hi David, I'd like a private walkthrough of Dazbeez Receipts.";
  assert.equal(normalizeMessagePrefill(msg), msg);
});

test("normalizeMessagePrefill preserves Japanese (Unicode) text", () => {
  const msg = "Dazbeez Receiptsの個別ウォークスルーを希望します。";
  assert.equal(normalizeMessagePrefill(msg), msg);
});

test("normalizeMessagePrefill uses the first value for repeated params / array input", () => {
  // Next.js surfaces ?message=a&message=b as ["a", "b"].
  assert.equal(normalizeMessagePrefill(["first message", "second message"]), "first message");
});

test("normalizeMessagePrefill returns empty string for missing, blank, or invalid input", () => {
  assert.equal(normalizeMessagePrefill(undefined), "");
  assert.equal(normalizeMessagePrefill(""), "");
  assert.equal(normalizeMessagePrefill("    "), "");
  assert.equal(normalizeMessagePrefill("\n\t  \n"), "");
  assert.equal(normalizeMessagePrefill([]), "");
  assert.equal(normalizeMessagePrefill([""]), "");
});

test("normalizeMessagePrefill trims surrounding whitespace but preserves internal line breaks", () => {
  assert.equal(normalizeMessagePrefill("  hello there  "), "hello there");
  assert.equal(normalizeMessagePrefill("\n\nLine one\nLine two\n\n"), "Line one\nLine two");
});

test("normalizeMessagePrefill clamps to the textarea's 4000-character limit", () => {
  const long = "a".repeat(CONTACT_MESSAGE_MAX_LENGTH + 50);
  const result = normalizeMessagePrefill(long);
  assert.equal(result.length, CONTACT_MESSAGE_MAX_LENGTH);
  assert.equal(result, long.slice(0, CONTACT_MESSAGE_MAX_LENGTH));

  // A value exactly at the limit is left untouched.
  const exact = "b".repeat(CONTACT_MESSAGE_MAX_LENGTH);
  assert.equal(normalizeMessagePrefill(exact), exact);
});
