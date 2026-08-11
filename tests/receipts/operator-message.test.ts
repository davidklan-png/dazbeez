import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveOperatorMessageForRebuild,
  assertExactlyOneRowWritten,
} from "@/lib/receipts/operator-message";

// Regression for the two SERVER-side latent bugs behind the 2026-06 message-loss
// incident (the incident itself was client-side — see the message_not_reviewed
// finalize gate). Both helpers are pure so the regressions are unit-testable
// without D1/R2 bindings. Each test documents the OLD (buggy) behaviour it
// replaces in the comment, so the "fails against current code" run is implicit:
// the old `body.operatorMessage ?? stored` and the old no-rows-written-OK path
// cannot satisfy these assertions.

// ─── A2-2: omitted ≠ empty (resolveOperatorMessageForRebuild) ─────────────────

test("rebuild resolve: an OMITTED body field preserves the stored value", () => {
  // OLD `body ?? stored`: undefined is nullish → returned stored. Same result
  // here, but this case must keep working after the field-presence rewrite.
  assert.equal(resolveOperatorMessageForRebuild(undefined, "保存済みの文面"), "保存済みの文面");
});

test("rebuild resolve: an explicit EMPTY STRING clears the message (null) — distinguishable from omitted", () => {
  // OLD `body ?? stored`: "" is NOT nullish, so `??` returned "" — but then it
  // was bound as operator_message and overwrote the stored value. The bug:
  // a rebuild carrying "" silently nulled the stored message. The fix: "" is a
  // deliberate clear → null. This is the §3 "omitted vs empty distinguishable" test.
  assert.equal(resolveOperatorMessageForRebuild("", "保存済みの文面"), null);
  assert.notEqual(
    resolveOperatorMessageForRebuild(undefined, "保存済みの文面"),
    resolveOperatorMessageForRebuild("", "保存済みの文面"),
    "omitted (→ stored) and empty (→ null) MUST differ",
  );
});

test("rebuild resolve: an explicit non-empty value wins over the stored value", () => {
  assert.equal(resolveOperatorMessageForRebuild("新しい文面", "古い文面"), "新しい文面");
});

test("rebuild resolve: whitespace-only body trims to null (clear)", () => {
  assert.equal(resolveOperatorMessageForRebuild("   \n  ", "保存済み"), null);
});

test("rebuild resolve: omitted with no stored value → null", () => {
  assert.equal(resolveOperatorMessageForRebuild(undefined, null), null);
});

// ─── A2-1: a no-op UPDATE is an error, not a silent 200 (assertExactlyOneRowWritten) ──

test("rows-written guard: exactly one row is accepted", () => {
  assert.doesNotThrow(() => assertExactlyOneRowWritten(1, "updateExportOperatorMessage(x)"));
});

test("rows-written guard: zero rows throws (a no-op UPDATE must surface, not return 200)", () => {
  // OLD path: 0 rows → D1 success → route 200 → UI "saved". The 2026-06 loss
  // was hard to diagnose partly because a no-op write looked like success.
  assert.throws(
    () => assertExactlyOneRowWritten(0, "updateExportOperatorMessage(x)"),
    /wrote 0 rows.*NOT persisted/,
  );
});

test("rows-written guard: two rows throws (a write affecting more than one row is wrong)", () => {
  assert.throws(
    () => assertExactlyOneRowWritten(2, "updateExportOperatorMessage(x)"),
    /wrote 2 rows.*NOT persisted/,
  );
});
