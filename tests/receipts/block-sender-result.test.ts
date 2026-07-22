// Tests for the inbox block-sender failure classifier.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyBlockRejectError } from "@/lib/receipts/block-sender-result";

test("classifyBlockRejectError: already promoted → partial-success", () => {
  const r = classifyBlockRejectError(new Error("Intake abc is already promoted (only pending_triage may be rejected)."));
  assert.equal(r.kind, "partial-success");
});

test("classifyBlockRejectError: already rejected → partial-success", () => {
  const r = classifyBlockRejectError(new Error("Intake abc is already rejected."));
  assert.equal(r.kind, "partial-success");
});

test("classifyBlockRejectError: D1 failure → genuine-failure", () => {
  const r = classifyBlockRejectError(new Error("D1: SQLITE_CONSTRAINT — foreign key"));
  assert.equal(r.kind, "genuine-failure");
  assert.match(r.message, /row rejection failed/);
});

test("classifyBlockRejectError: audit failure → genuine-failure", () => {
  const r = classifyBlockRejectError(new Error("Failed to create audit entry."));
  assert.equal(r.kind, "genuine-failure");
});

test("classifyBlockRejectError: arbitrary exception → genuine-failure", () => {
  const r = classifyBlockRejectError(new TypeError("Cannot read properties of undefined"));
  assert.equal(r.kind, "genuine-failure");
  assert.match(r.message, /row rejection failed/);
});

test("classifyBlockRejectError: non-Error thrown → genuine-failure", () => {
  const r = classifyBlockRejectError("something broke");
  assert.equal(r.kind, "genuine-failure");
});
