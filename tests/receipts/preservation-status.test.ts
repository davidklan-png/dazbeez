// Tests for derivePreservationStatus (lib/receipts/db.ts) — migration 0014's
// backfill CASE as the single authority for preservation_status (#18 audit / #23).
// Both capture paths previously hardcoded a literal ('needs_review' / 'captured'),
// disagreeing with 0014's 'needs_metadata' for status='captured'.

import test from "node:test";
import assert from "node:assert/strict";
import { derivePreservationStatus } from "@/lib/receipts/db";
import type { ReceiptStatus } from "@/lib/receipts/types";

const s = (v: string): ReceiptStatus => v as ReceiptStatus;

test("derivePreservationStatus: 0014 CASE — status → preservation_status", () => {
  assert.equal(derivePreservationStatus(s("captured")), "needs_metadata");
  assert.equal(derivePreservationStatus(s("reviewed")), "reviewed");
  assert.equal(derivePreservationStatus(s("reconciled")), "reviewed");
  assert.equal(derivePreservationStatus(s("exported")), "exported");
  assert.equal(derivePreservationStatus(s("archived")), "archived");
  assert.equal(derivePreservationStatus(s("needs_review")), "needs_review"); // ELSE
  assert.equal(derivePreservationStatus(undefined), "needs_review"); // default status
});

test("derivePreservationStatus: a capture (status=captured) is needs_metadata — ends the 3-way disagreement", () => {
  // createReceiptRecord hardcoded 'needs_review'; createMobileReceiptRecord
  // 'captured'; 0014's authority is 'needs_metadata'. The derivation makes the
  // merged insert correct; existing rows are backfilled separately (#23).
  assert.equal(derivePreservationStatus(s("captured")), "needs_metadata");
  assert.notEqual(derivePreservationStatus(s("captured")), "needs_review");
  assert.notEqual(derivePreservationStatus(s("captured")), "captured");
});
