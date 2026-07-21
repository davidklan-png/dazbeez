import test from "node:test";
import assert from "node:assert/strict";
import {
  canMarkReviewed,
  canPromoteToReviewed,
  planReviewStatusTransition,
  REVIEW_PATCH_ALLOWED_STATUS,
} from "@/lib/receipts/receipt-status-policy";
import type { ReceiptStatus } from "@/lib/receipts/types";

function plan(current: ReceiptStatus, requested: string | undefined) {
  return planReviewStatusTransition({ currentStatus: current, requestedStatus: requested });
}

// ─── canPromoteToReviewed (drives the "Mark reviewed" button) ─────────────────

test("canPromoteToReviewed: true only for pre-review states", () => {
  assert.equal(canPromoteToReviewed("captured"), true);
  assert.equal(canPromoteToReviewed("needs_review"), true);
  assert.equal(canPromoteToReviewed("reviewed"), false);
  assert.equal(canPromoteToReviewed("reconciled"), false);
  assert.equal(canPromoteToReviewed("exported"), false);
  assert.equal(canPromoteToReviewed("archived"), false);
});

// ─── canMarkReviewed: the shared button + `s`-shortcut gate ───────────────────
// Both the "Mark reviewed" button (disabled) and the `s` keyboard shortcut route
// through this single predicate, so they can never disagree. A non-promotable
// but merely-unlocked receipt must not save-and-advance via the shortcut.

test("canMarkReviewed: true only when unlocked AND pre-review", () => {
  assert.equal(canMarkReviewed("captured", false), true);
  assert.equal(canMarkReviewed("needs_review", false), true);
  for (const s of ["reviewed", "reconciled", "exported", "archived"] as ReceiptStatus[]) {
    assert.equal(canMarkReviewed(s, false), false, `${s} should not be mark-reviewable`);
  }
});

test("canMarkReviewed: a locked form never allows the action, even for captured", () => {
  assert.equal(canMarkReviewed("captured", true), false);
  assert.equal(canMarkReviewed("needs_review", true), false);
  assert.equal(canMarkReviewed("reconciled", true), false);
});

// ─── planReviewStatusTransition ───────────────────────────────────────────────

test("autosave (no status field) is a noop — lifecycle status never touched", () => {
  for (const current of ["captured", "needs_review", "reviewed", "reconciled", "exported", "archived"] as ReceiptStatus[]) {
    assert.deepEqual(plan(current, undefined), { outcome: "noop" });
  }
});

test("captured/needs_review → reviewed is applied", () => {
  assert.deepEqual(plan("captured", "reviewed"), { outcome: "apply", status: "reviewed" });
  assert.deepEqual(plan("needs_review", "reviewed"), { outcome: "apply", status: "reviewed" });
});

test("already reviewed + requested reviewed is an idempotent noop (no error)", () => {
  assert.deepEqual(plan("reviewed", "reviewed"), { outcome: "noop" });
});

test("non-\"reviewed\" requested statuses are rejected 400 — this endpoint owns only the promotion", () => {
  for (const bad of ["needs_review", "captured", "reconciled", "exported", "archived", "garbage", ""]) {
    const r = plan("needs_review", bad);
    assert.equal(r.outcome, "reject", `expected reject for "${bad}"`);
    assert.equal((r as { httpStatus: number }).httpStatus, 400);
  }
});

test("reconciled/exported/archived cannot be demoted to reviewed via the review endpoint (409)", () => {
  for (const current of ["reconciled", "exported", "archived"] as ReceiptStatus[]) {
    const r = plan(current, "reviewed");
    assert.equal(r.outcome, "reject", `expected reject for ${current}`);
    assert.equal((r as { httpStatus: number }).httpStatus, 409);
  }
});

test("REVIEW_PATCH_ALLOWED_STATUS is exactly 'reviewed'", () => {
  assert.equal(REVIEW_PATCH_ALLOWED_STATUS, "reviewed");
});

// ─── Request-shape contract (the two form-pane PATCH shapes through the planner)
// These pin the client→server contract: an autosave body has no `status` key
// (plan → noop), and a Mark-reviewed body carries `status:"reviewed"` only when
// the receipt is still promotable (plan → apply), never on a reconciled receipt
// (plan → reject). The server planner is the authoritative guard, so exercising
// it with the exact request shapes covers the contract end-to-end here.

test("request-shape: autosave body (no status key) leaves a reconciled receipt untouched", () => {
  // Autosave never includes status, even on a reconciled receipt.
  const autosaveBody = { merchant: "X", amountMinor: 100 } as Record<string, unknown>;
  assert.equal("status" in autosaveBody, false);
  assert.deepEqual(plan("reconciled", autosaveBody.status as string | undefined), { outcome: "noop" });
});

test("request-shape: Mark-reviewed on a promotable receipt sends status=reviewed and is applied", () => {
  const markBody = { merchant: "X", status: "reviewed" };
  assert.equal(markBody.status, "reviewed");
  assert.deepEqual(plan("needs_review", markBody.status), { outcome: "apply", status: "reviewed" });
});

test("request-shape: a stale Mark-reviewed reaching a reconciled receipt is rejected (the downgrade guard)", () => {
  // The client no longer sends this, but the server must still refuse it.
  assert.deepEqual(plan("reconciled", "reviewed").outcome, "reject");
});
