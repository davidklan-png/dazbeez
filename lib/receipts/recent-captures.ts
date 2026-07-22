// Recent-captures surface for the Capture page. This is the lightweight,
// DB-backed "what you just captured" history — distinct from the in-memory
// session batch (see lib/receipts/session-upload.ts). It reads a small
// projected slice of receipt_records (no extraction_json, no SELECT *) via a
// dedicated endpoint and refreshes live as extraction advances.
//
// Client-safe and dependency-free: no server-only, runtime-binding, React, or
// Next.js imports. Shared by the API route (server), the Capture page (server
// seed), and the Capture client (status derivation + polling decision).

import {
  PENDING_EXTRACTION_STATES,
  type ExtractionState,
  type ReceiptStatus,
} from "@/lib/receipts/types";

/** Number of recent captures shown in the Capture page rail. */
export const RECENT_CAPTURE_LIMIT = 5;

/** Polling cadence while any visible recent capture is still pending. */
export const RECENT_CAPTURE_POLL_MS = 15_000;

/**
 * The projected, display-only slice of a receipt_records row returned by the
 * recent-captures query/endpoint. Mirrors exactly the columns selected in
 * lib/receipts/db.ts listRecentCaptures — deliberately excludes
 * `extraction_json` and every large/unused column so the rail stays cheap.
 */
export interface RecentCapture {
  id: string;
  captured_at: string;
  merchant: string | null;
  original_filename: string | null;
  status: ReceiptStatus;
  extraction_state: ExtractionState | null;
  needs_render: number | null;
  amount_minor: number | null;
  currency: string | null;
}

/** Visual tone for a recent-capture status pill. */
export type RecentCaptureTone =
  | "red"
  | "amber"
  | "green"
  | "charcoal"
  | "gray";

/** A resolved, render-ready status for a recent capture row. */
export interface RecentCaptureStatus {
  label: string;
  tone: RecentCaptureTone;
}

/**
 * The "is this still in flight?" predicate the client uses to decide whether to
 * keep polling. True while extraction is pending OR the row still awaits a Mac
 * render. A permanently-failed extraction is terminal and does NOT keep polling
 * (it surfaces as a red pill for the operator, not a forever-spinner).
 *
 * Kept in lockstep with the "Processing" branch of {@link
 * deriveRecentCaptureStatus} so the poll decision and the visible badge can
 * never disagree about what "pending" means.
 */
export function isRecentCapturePending(item: RecentCapture): boolean {
  if (item.extraction_state === "failed") return false;
  if (
    item.extraction_state !== null &&
    PENDING_EXTRACTION_STATES.includes(item.extraction_state)
  ) {
    return true;
  }
  return item.needs_render === 1;
}

/**
 * Derive the display status for a recent capture, in this precedence (matching
 * the Capture-page spec):
 *
 *   1. extraction_state=failed        → "Extraction failed" (red)
 *   2. pending extraction / needs_render → "Processing" (amber)
 *   3. status=needs_review            → "Needs review" (amber)
 *   4. status=reviewed                → "Reviewed" (gray)
 *   5. status=reconciled              → "Reconciled" (green)
 *   6. status=exported                → "Exported" (charcoal)
 *   7. status=archived                → "Archived" (gray)
 *   8. otherwise (status=captured)    → "Captured" (gray)
 *
 * Extraction (queue/render) state outranks the user-facing lifecycle status:
 * a `status=captured` row that is still queued reads "Processing", not
 * "Captured", until the Mac consumer lands fields.
 */
export function deriveRecentCaptureStatus(
  item: RecentCapture,
): RecentCaptureStatus {
  if (item.extraction_state === "failed") {
    return { label: "Extraction failed", tone: "red" };
  }
  if (isRecentCapturePending(item)) {
    return { label: "Processing", tone: "amber" };
  }
  switch (item.status) {
    case "needs_review":
      return { label: "Needs review", tone: "amber" };
    case "reviewed":
      return { label: "Reviewed", tone: "gray" };
    case "reconciled":
      return { label: "Reconciled", tone: "green" };
    case "exported":
      return { label: "Exported", tone: "charcoal" };
    case "archived":
      return { label: "Archived", tone: "gray" };
    default:
      return { label: "Captured", tone: "gray" };
  }
}
