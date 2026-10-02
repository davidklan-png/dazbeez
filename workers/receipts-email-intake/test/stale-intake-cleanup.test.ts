// Tests for staleRejectReason (lib/receipts/email-parse.ts) — the display-only
// reject_reason the scheduled cleanup stamps on a still-pending intake row
// whose attachment R2 object it just deleted.
// Run from the worker directory:
//   npx tsx --test test/stale-intake-cleanup.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { staleRejectReason } from "../../../lib/receipts/email-parse";

test("pending_triage + null reason → stale-attachment message", () => {
  assert.equal(
    staleRejectReason("pending_triage", null),
    "attachment expired — R2 object deleted after 30 days pending",
  );
});

test("rejected row (has its real reason) → null", () => {
  assert.equal(staleRejectReason("rejected", "blocked_sender"), null);
});

test("pending row that already has a reason → null (never overwritten)", () => {
  assert.equal(staleRejectReason("pending_triage", "no attachment"), null);
});
