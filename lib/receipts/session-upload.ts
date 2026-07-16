// Client-safe model for a desktop capture session row + its pure state
// transitions. Extracted from ReceiptCaptureForm so the desktop upload
// state machine is unit-testable without a DOM harness. No React, no server
// imports.

export type SessionUploadState = "uploading" | "ready" | "review" | "error";

export interface SessionUpload {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  state: SessionUploadState;
  pct: number;
  merchant?: string;
  amount?: string;
  date?: string;
  receiptId?: string;
  errorMessage?: string;
}

/**
 * Pure transitions for a desktop session row. Each returns a NEW row (never
 * undefined) — there is no "remove" transition, so a cancelled/failed upload
 * can never be silently dropped from the batch. Callers apply these via
 * sessionUploads.map((u) => (u.id === id ? transition(u, ...) : u)).
 */

export function applyUploadSuccess(
  row: SessionUpload,
  receiptId: string,
): SessionUpload {
  return { ...row, state: "ready", pct: 100, receiptId };
}

export function applyUploadFailure(
  row: SessionUpload,
  message: string,
): SessionUpload {
  return { ...row, state: "error", pct: 100, errorMessage: message };
}

/**
 * Cancellation transition. The row is RETAINED (returned, not removed) and
 * surfaced as a visible error tile carrying a "Cancelled" message. This is the
 * pure-function guarantee that cancellation never silently drops a row;
 * BatchTile already renders errorMessage, so no DOM harness is required.
 */
export function applyUploadCancellation(row: SessionUpload): SessionUpload {
  return applyUploadFailure(row, "Cancelled");
}
