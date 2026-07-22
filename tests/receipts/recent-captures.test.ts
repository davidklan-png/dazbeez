import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveRecentCaptureStatus,
  isRecentCapturePending,
} from "@/lib/receipts/recent-captures";
import type { RecentCapture } from "@/lib/receipts/recent-captures";
import type {
  ExtractionState,
  ReceiptStatus,
} from "@/lib/receipts/types";

function item(over: Partial<RecentCapture> = {}): RecentCapture {
  return {
    id: "r1",
    captured_at: "2026-07-22T01:00:00.000Z",
    merchant: null,
    original_filename: null,
    status: "captured",
    extraction_state: null,
    needs_render: null,
    amount_minor: null,
    currency: null,
    ...over,
  };
}

// ─── deriveRecentCaptureStatus: precedence ──────────────────────────────────

test("status: failed extraction wins everything (red)", () => {
  // Even with a late lifecycle status or a pending-ish render flag, failed is
  // the top-precedence terminal signal.
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ extraction_state: "failed", status: "reviewed", needs_render: 1 })),
    { label: "Extraction failed", tone: "red" },
  );
});

test("status: pending extraction → Processing (amber), regardless of lifecycle status", () => {
  for (const es of ["captured", "queued", "processing"] as ExtractionState[]) {
    assert.deepEqual(
      deriveRecentCaptureStatus(item({ extraction_state: es, status: "captured" })),
      { label: "Processing", tone: "amber" },
      `extraction_state=${es}`,
    );
  }
  // Extraction state outranks lifecycle: a still-queued row whose status somehow
  // advanced reads Processing, not the lifecycle label.
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ extraction_state: "queued", status: "reconciled" })),
    { label: "Processing", tone: "amber" },
  );
});

test("status: needs_render=1 → Processing (amber) even with no extraction_state", () => {
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ needs_render: 1, extraction_state: null })),
    { label: "Processing", tone: "amber" },
  );
});

test("status: lifecycle ordering after extraction is settled", () => {
  const processed: ExtractionState = "processed";
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ extraction_state: processed, status: "needs_review" as ReceiptStatus })),
    { label: "Needs review", tone: "amber" },
  );
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ extraction_state: processed, status: "reviewed" })),
    { label: "Reviewed", tone: "gray" },
  );
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ extraction_state: processed, status: "reconciled" })),
    { label: "Reconciled", tone: "green" },
  );
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ extraction_state: processed, status: "exported" })),
    { label: "Exported", tone: "charcoal" },
  );
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ extraction_state: processed, status: "archived" })),
    { label: "Archived", tone: "gray" },
  );
});

test("status: otherwise (status=captured, nothing pending) → Captured (gray)", () => {
  assert.deepEqual(
    deriveRecentCaptureStatus(item({ extraction_state: "processed", status: "captured" })),
    { label: "Captured", tone: "gray" },
  );
  // Null extraction_state + null needs_render + status captured also falls through.
  assert.deepEqual(
    deriveRecentCaptureStatus(item()),
    { label: "Captured", tone: "gray" },
  );
});

// ─── isRecentCapturePending: the polling decision ───────────────────────────

test("pending: true for pending extraction states and needs_render", () => {
  for (const es of ["captured", "queued", "processing"] as ExtractionState[]) {
    assert.equal(isRecentCapturePending(item({ extraction_state: es })), true, es);
  }
  assert.equal(isRecentCapturePending(item({ needs_render: 1 })), true);
});

test("pending: false for failed (terminal) — does not keep polling", () => {
  assert.equal(isRecentCapturePending(item({ extraction_state: "failed" })), false);
  // Even with needs_render flagged, a failed extraction is terminal.
  assert.equal(
    isRecentCapturePending(item({ extraction_state: "failed", needs_render: 1 })),
    false,
  );
});

test("pending: false once extraction is processed and not awaiting render", () => {
  assert.equal(isRecentCapturePending(item({ extraction_state: "processed" })), false);
  assert.equal(isRecentCapturePending(item({ extraction_state: null })), false);
});

// ─── lockstep: pending decision ⇄ Processing badge ──────────────────────────

test("pending decision and Processing badge agree on every extraction state", () => {
  const states: (ExtractionState | null)[] = [
    "captured",
    "queued",
    "processing",
    "processed",
    "failed",
    null,
  ];
  for (const es of states) {
    const status = deriveRecentCaptureStatus(item({ extraction_state: es }));
    const pending = isRecentCapturePending(item({ extraction_state: es }));
    if (status.label === "Processing") {
      assert.equal(pending, true, `Processing badge should imply pending (es=${es})`);
    } else {
      assert.equal(pending, false, `non-Processing badge should imply not pending (es=${es})`);
    }
  }
});
