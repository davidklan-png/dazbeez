// Client-safe shared upload policy for receipt capture.
//
// This module is imported by BOTH client components (capture UI) and server
// routes (enforcement) so the two cannot drift apart. It must stay free of any
// server-only import (no cloudflare-runtime, no Node-only APIs) — it runs in
// the browser bundle.
//
// Architect decisions captured here (2026-07-16):
//   - EML/HTML are NOT accepted: no email/HTML ingestion pipeline exists, so
//     advertising them would let users drop files the server then rejects.
//   - The 5 MiB limit is kept (extraction request body is base64 ≈1.33× and
//     JSON-stringified; larger files risk Error 1102 under back-to-back runs).
//   - Desktop batches are capped at 25 files; overflow is rejected visibly.
//   - Desktop upload concurrency is 3 (FIFO beyond that).
//   - Provenance (`source`) is required and must be a known value; the route
//     no longer silently defaults to "mobile_capture", which had mislabeled
//     every desktop upload.

import type { SourceType } from "@/lib/receipts/types";

// ─── Accepted file types ───────────────────────────────────────────────────

export const ALLOWED_RECEIPT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/pdf",
] as const;

export const ALLOWED_RECEIPT_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".pdf",
] as const;

// `<input accept>` for the desktop dropzone, derived from the same extension
// list as the server validator. Enumerates accepted formats explicitly — no
// `image/*` wildcard, which would advertise formats (GIF, BMP, SVG, …) the
// server rejects. Deliberately excludes .eml/.html (see header).
export const RECEIPT_ACCEPT_ATTR = ALLOWED_RECEIPT_EXTENSIONS.join(",");

// ─── Size / batch / concurrency limits ─────────────────────────────────────

// 5 MiB cap on both upload and extraction. See header for the 1102 rationale.
export const MAX_RECEIPT_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

// Desktop drop batch cap. Enforced at the dropzone; overflow is surfaced as a
// visible rejection rather than silently dropped.
export const MAX_DESKTOP_BATCH_FILES = 25;

// Max concurrent uploads on the desktop path. Drops beyond this queue in order
// (FIFO) — see receipt-capture-form.tsx's UploadPool.
export const DESKTOP_MAX_CONCURRENT_UPLOADS = 3;

// ─── Capture source / provenance ───────────────────────────────────────────

// The `source` column records how a receipt entered the system. The upload
// route requires an explicit, valid value — it no longer silently defaults to
// "mobile_capture". The capture client selects the value: mobile web →
// mobile_capture, desktop → desktop_upload. (The native iOS path uses a
// separate route and hardcodes mobile_capture.)
export const VALID_SOURCES = ["mobile_capture", "desktop_upload"] as const;
export type Source = (typeof VALID_SOURCES)[number];

export function isValidSource(value: string | undefined): value is Source {
  return !!value && (VALID_SOURCES as readonly string[]).includes(value);
}

// `source_type` is the document classification. An explicit valid value from
// the client wins; otherwise it is derived. This is the single source of truth
// — previously duplicated in app/api/receipts/upload and [id] routes.
export const VALID_SOURCE_TYPES: readonly SourceType[] = [
  "paper_scanned",
  "electronic_receipt",
  "digital_invoice",
  "credit_card_statement",
  "email_attachment",
  "manual_upload",
  "amex_csv",
];

/**
 * Classify a receipt's source_type. Rules (architect-confirmed 2026-07-16):
 *   1. An explicit, valid sourceType from the client wins.
 *   2. mobile_capture → paper_scanned (camera capture, regardless of content).
 *   3. application/pdf → electronic_receipt.
 *   4. otherwise → manual_upload (e.g. a desktop image drop).
 *
 * No filename-based "paper scan" detection — the system lacks the information
 * to infer that reliably (a phone-scanned paper receipt dropped via desktop
 * stays manual_upload until the operator says otherwise).
 */
export function deriveSourceType(
  explicitSourceType: string | undefined,
  source: Source,
  contentType: string,
): SourceType {
  if (
    explicitSourceType &&
    VALID_SOURCE_TYPES.includes(explicitSourceType as SourceType)
  ) {
    return explicitSourceType as SourceType;
  }
  if (source === "mobile_capture") return "paper_scanned";
  if (contentType === "application/pdf") return "electronic_receipt";
  return "manual_upload";
}

// ─── Validation ────────────────────────────────────────────────────────────

/** Lowercased ".ext" (including the dot) from a filename; "" if there is none. */
function fileExtensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "";
  return name.slice(dot).toLowerCase();
}

export function validateReceiptFile(file: File): string | null {
  if (file.size > MAX_RECEIPT_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `File is too large (${mb} MB). Maximum allowed size is ${formatFileSize(MAX_RECEIPT_FILE_BYTES)}.`;
  }

  const ext = fileExtensionOf(file.name);
  const mime = file.type;
  const errMsg = "File type not allowed. Accepted: JPEG, PNG, HEIC, PDF.";

  // The extension is only a fallback when the MIME is absent or generic. A
  // specific MIME must itself be allowlisted — otherwise a text/html payload
  // named *.jpg, or an image/gif, would slip through on extension alone.
  if (mime === "" || mime === "application/octet-stream") {
    return (ALLOWED_RECEIPT_EXTENSIONS as readonly string[]).includes(ext)
      ? null
      : errMsg;
  }
  return (ALLOWED_RECEIPT_MIME_TYPES as readonly string[]).includes(mime)
    ? null
    : errMsg;
}

/**
 * Split a selection into an accepted prefix (≤ limit) and a rejected count.
 * Pure. Used to enforce the per-drop desktop batch cap WITHOUT subtracting the
 * existing session — a session-cumulative cap would lock the session out over
 * time as ready/review rows accumulate. Each drop is independently capped.
 */
export function partitionBatch<T>(
  items: readonly T[],
  limit: number,
): { accepted: T[]; rejected: number } {
  if (items.length <= limit) {
    return { accepted: items.slice(), rejected: 0 };
  }
  return { accepted: items.slice(0, limit), rejected: items.length - limit };
}

// ─── Display formatting (client-safe; used in copy so it can't drift) ──────

// Renders a byte count as a compact human string. Kept here (not inlined in
// copy) so "20 MB" / "5 MB" style claims can never diverge from the real limit.
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  const mib = bytes / (1024 * 1024);
  return `${mib} MB`;
}
