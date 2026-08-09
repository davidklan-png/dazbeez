// Tests for the capture contract's pure pieces (lib/receipts/capture.ts).
// captureReceipt itself is binding-coupled (D1 + R2 + Queue); its decisions are
// extracted as pure helpers and covered here. The contract enforcement (one
// createReceiptRecord importer; one INSERT path) lives in capture-contract.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCaptureFileInput,
  decideCaptureMark,
  isMobileIdempotencyCollision,
  CaptureIdempotencyConflict,
  CaptureManifestFailure,
} from "@/lib/receipts/capture";

// ─── decideCaptureMark (the #20 marker logic) ───────────────────────────────

test("decideCaptureMark: not attempted (needs_render) → captured, no timestamps", () => {
  const m = decideCaptureMark({ attempted: false, enqueued: false, now: "NOW" });
  assert.equal(m.extractionState, "captured");
  assert.equal(m.extractionEnqueuedAt, null);
  assert.equal(m.extractionEnqueueFailedAt, null);
});

test("decideCaptureMark: attempted + enqueued → queued + enqueued_at, no failed_at", () => {
  const m = decideCaptureMark({ attempted: true, enqueued: true, now: "NOW" });
  assert.equal(m.extractionState, "queued");
  assert.equal(m.extractionEnqueuedAt, "NOW");
  assert.equal(m.extractionEnqueueFailedAt, null);
});

test("decideCaptureMark: attempted + FAILED (queue outage) → captured + failed_at marker (#20)", () => {
  // This is the marker that distinguishes a queue outage from a forgotten enqueue.
  const m = decideCaptureMark({ attempted: true, enqueued: false, now: "NOW" });
  assert.equal(m.extractionState, "captured");
  assert.equal(m.extractionEnqueuedAt, null);
  assert.equal(m.extractionEnqueueFailedAt, "NOW");
});

// ─── buildCaptureFileInput (the manifest row) ────────────────────────────────

test("buildCaptureFileInput: r2Key is the given key, isOriginal true, fields mapped", () => {
  const f = buildCaptureFileInput({
    receiptId: "r1",
    r2Key: "receipts/2026/08/r1/abc.pdf",
    file: { sha256: "deadbeef", sizeBytes: 99, contentType: "application/pdf", filename: "r.pdf" },
    actor: "op@dazbeez.com",
  });
  assert.equal(f.r2Key, "receipts/2026/08/r1/abc.pdf");
  assert.equal(f.isOriginal, true);
  assert.equal(f.objectType, "receipt");
  assert.equal(f.objectId, "r1");
  assert.equal(f.role, "original");
  assert.equal(f.r2Bucket, "receipts");
  assert.equal(f.sha256Hash, "deadbeef");
  assert.equal(f.fileSizeBytes, 99);
  assert.equal(f.originalFilename, "r.pdf");
  assert.equal(f.uploadedBy, "op@dazbeez.com");
});

// ─── isMobileIdempotencyCollision (the #18 ii-c(b) classification) ──────────

test("isMobileIdempotencyCollision: D1 UNIQUE on device_id/client_capture_id → true (race)", () => {
  assert.equal(
    isMobileIdempotencyCollision(
      new Error("UNIQUE constraint failed: receipt_records.device_id, receipt_records.client_capture_id"),
    ),
    true,
  );
});

test("isMobileIdempotencyCollision: a manifest/other error → false (NOT a race)", () => {
  // This is the crux of (b): a manifest failure must NOT be mistaken for a race,
  // or the route returns duplicate:true on a row it just deleted.
  assert.equal(isMobileIdempotencyCollision(new Error("some other db error")), false);
  assert.equal(isMobileIdempotencyCollision(new CaptureManifestFailure()), false);
  assert.equal(isMobileIdempotencyCollision(null), false);
});

// ─── typed errors are distinguishable (the route branches on them) ──────────

test("typed errors: CaptureIdempotencyConflict and CaptureManifestFailure are distinct", () => {
  const race = new CaptureIdempotencyConflict();
  const manifest = new CaptureManifestFailure();
  assert.equal(race instanceof CaptureIdempotencyConflict, true);
  assert.equal(manifest instanceof CaptureManifestFailure, true);
  assert.equal(race instanceof CaptureManifestFailure, false);
  assert.equal(manifest instanceof CaptureIdempotencyConflict, false);
  assert.equal(race.kind, "CaptureIdempotencyConflict");
  assert.equal(manifest.kind, "CaptureManifestFailure");
});
