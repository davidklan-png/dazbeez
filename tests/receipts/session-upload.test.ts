import test from "node:test";
import assert from "node:assert/strict";
import {
  applyUploadCancellation,
  applyUploadFailure,
  applyUploadSuccess,
  type SessionUpload,
} from "@/lib/receipts/session-upload";

function uploadingRow(): SessionUpload {
  return {
    id: "r1",
    fileName: "a.jpg",
    fileSizeBytes: 1024,
    state: "uploading",
    pct: 30,
  };
}

test("applyUploadSuccess: ready, pct 100, receiptId retained, identity preserved", () => {
  const out = applyUploadSuccess(uploadingRow(), "rid-9");
  assert.equal(out.state, "ready");
  assert.equal(out.pct, 100);
  assert.equal(out.receiptId, "rid-9");
  assert.equal(out.id, "r1");
  assert.equal(out.fileName, "a.jpg"); // other fields preserved
});

test("applyUploadFailure: error, pct 100, non-empty errorMessage retained", () => {
  const out = applyUploadFailure(uploadingRow(), "Upload failed");
  assert.equal(out.state, "error");
  assert.equal(out.pct, 100);
  assert.equal(out.errorMessage, "Upload failed");
  assert.equal(out.id, "r1");
});

test("applyUploadCancellation: row retained with a visible message, never removed", () => {
  const row = uploadingRow();
  const out = applyUploadCancellation(row);

  // Cancellation returns a row (not undefined) — it must not silently drop it.
  assert.ok(out, "cancellation must return a row, not remove it");
  assert.equal(out.state, "error");
  assert.ok(
    typeof out.errorMessage === "string" && out.errorMessage.length > 0,
    "cancelled row must carry a visible message",
  );
  assert.equal(out.id, "r1"); // same row, retained
  assert.equal(out.pct, 100);

  // Original is untouched (immutability).
  assert.equal(row.state, "uploading");
});

test("transitions applied via .map never drop sibling rows", () => {
  const rows: SessionUpload[] = [
    { id: "a", fileName: "a.jpg", fileSizeBytes: 1, state: "uploading", pct: 5 },
    { id: "b", fileName: "b.jpg", fileSizeBytes: 1, state: "uploading", pct: 5 },
  ];
  const updated = rows.map((u) =>
    u.id === "a" ? applyUploadFailure(u, "err") : u,
  );

  assert.equal(updated.length, 2); // both rows still present
  assert.equal(updated[0]!.state, "error");
  assert.equal(updated[0]!.errorMessage, "err");
  assert.equal(updated[1]!.state, "uploading"); // sibling untouched
});
