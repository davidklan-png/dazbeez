import assert from "node:assert/strict";
import test from "node:test";
import { getExtractionHealth } from "@/lib/receipts/extraction-state";
import type { ReceiptRecord } from "@/lib/receipts/types";

const NOW = Date.parse("2026-06-20T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

function receipt(partial: Partial<ReceiptRecord>): ReceiptRecord {
  return {
    id: "r1",
    status: "needs_review",
    captured_at: minsAgo(1),
    ...partial,
  } as unknown as ReceiptRecord;
}

test("health: no pending receipts is OK and up to date", () => {
  const h = getExtractionHealth(
    [receipt({ extraction_state: "processed", extraction_processed_at: minsAgo(2) })],
    NOW,
  );
  assert.equal(h.ok, true);
  assert.equal(h.pendingCount, 0);
  assert.equal(h.reason, "Up to date");
  assert.equal(h.lastProcessedAt, minsAgo(2));
});

test("health: recently queued receipts are OK (processor expected to drain)", () => {
  const h = getExtractionHealth(
    [
      receipt({
        id: "a",
        status: "captured",
        extraction_state: "queued",
        extraction_enqueued_at: minsAgo(5),
      }),
    ],
    NOW,
  );
  assert.equal(h.ok, true);
  assert.equal(h.pendingCount, 1);
  assert.match(h.reason, /Processing — 1 in queue/);
});

test("health: a pending receipt older than the stale threshold is stalled", () => {
  const h = getExtractionHealth(
    [
      receipt({
        id: "a",
        status: "captured",
        extraction_state: "queued",
        extraction_enqueued_at: minsAgo(45),
      }),
      receipt({
        id: "b",
        status: "captured",
        extraction_state: "captured",
        extraction_enqueued_at: minsAgo(10),
      }),
    ],
    NOW,
  );
  assert.equal(h.ok, false);
  assert.equal(h.level, "stalled");
  assert.equal(h.pendingCount, 2);
  assert.match(h.reason, /Processor stalled — 2 waiting, oldest 45m/);
});

test("health: falls back to captured_at when no enqueued_at, and reports hours", () => {
  const h = getExtractionHealth(
    [receipt({ id: "a", status: "captured", captured_at: minsAgo(150) })],
    NOW,
  );
  assert.equal(h.ok, false);
  assert.match(h.reason, /oldest 2h/);
});

test("health: oldest age is the max across pending rows", () => {
  const h = getExtractionHealth(
    [
      receipt({ id: "a", status: "captured", extraction_enqueued_at: minsAgo(8) }),
      receipt({ id: "b", status: "captured", extraction_enqueued_at: minsAgo(30) }),
    ],
    NOW,
  );
  assert.equal(h.oldestPendingAgeMs, 30 * 60000);
  assert.equal(h.ok, false);
});
