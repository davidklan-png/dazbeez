import assert from "node:assert/strict";
import test from "node:test";
import { buildQueueItems } from "@/lib/receipts/queue-items";
import type { ReceiptRecord } from "@/lib/receipts/types";

function receipt(partial: Partial<ReceiptRecord>): ReceiptRecord {
  return {
    id: "r1",
    status: "captured",
    captured_at: "2026-07-05T10:00:00.000Z",
    merchant: null,
    amount_minor: null,
    currency: "JPY",
    expense_category_code: null,
    business_purpose: null,
    transaction_date: null,
    extraction_state: "captured",
    extraction_json: null,
    ...partial,
  } as unknown as ReceiptRecord;
}

test("buildQueueItems: extraction-failed receipt is flagged with reason from extraction_json", () => {
  const items = buildQueueItems([
    receipt({
      id: "failed-with-reason",
      extraction_state: "failed",
      extraction_json: JSON.stringify({
        failed: true,
        reason: "UnidentifiedImageError: cannot identify image file",
        model: "mlx_local:qwen3-vl-32b",
        failedAt: "2026-07-05T10:05:00.000Z",
      }),
    }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].extractionFailed, true);
  assert.equal(
    items[0].failureReason,
    "UnidentifiedImageError: cannot identify image file",
  );
  // Pending extraction never went stale in this fixture, so stuck stays false.
  assert.equal(items[0].stuck, false);
});

test("buildQueueItems: extraction-failed with missing/malformed JSON still flags the pill", () => {
  const items = buildQueueItems([
    receipt({
      id: "failed-no-json",
      extraction_state: "failed",
      extraction_json: null,
    }),
    receipt({
      id: "failed-malformed-json",
      extraction_state: "failed",
      extraction_json: "{not json",
    }),
  ]);
  assert.equal(items[0].extractionFailed, true);
  assert.equal(items[0].failureReason, null);
  assert.equal(items[1].extractionFailed, true);
  assert.equal(items[1].failureReason, null);
});

test("buildQueueItems: non-failed receipts never show the failed pill", () => {
  const items = buildQueueItems([
    receipt({ id: "captured", extraction_state: "captured" }),
    receipt({ id: "queued", extraction_state: "queued" }),
    receipt({ id: "processing", extraction_state: "processing" }),
    receipt({ id: "processed", extraction_state: "processed" }),
    // Even if extraction_json somehow has {failed:true}, the pill is gated
    // on extraction_state === 'failed' so a stale payload on a recovered
    // receipt doesn't keep rendering red.
    receipt({
      id: "recovered",
      extraction_state: "processed",
      extraction_json: JSON.stringify({ failed: true }),
    }),
  ]);
  for (const item of items) {
    assert.equal(item.extractionFailed, false, `${item.id} should not be flagged`);
    assert.equal(item.failureReason, null);
  }
});

test("buildQueueItems: failure reason is truncated to 300 chars (tooltip sanity)", () => {
  const longReason = "x".repeat(500);
  const items = buildQueueItems([
    receipt({
      id: "long-reason",
      extraction_state: "failed",
      extraction_json: JSON.stringify({ failed: true, reason: longReason }),
    }),
  ]);
  assert.equal(items[0].failureReason?.length, 300);
});
