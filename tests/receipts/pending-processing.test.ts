import assert from "node:assert/strict";
import test from "node:test";
import { buildExtractionJob, EXTRACTION_JOB_VERSION } from "@/lib/receipts/queue";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import { computeExportBlockers } from "@/lib/receipts/blockers";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

function receipt(partial: Partial<ReceiptRecord>): ReceiptRecord {
  return {
    id: "r1",
    status: "needs_review",
    transaction_date: null,
    ...partial,
  } as unknown as ReceiptRecord;
}

test("buildExtractionJob: stamps version and fields", () => {
  const job = buildExtractionJob({ receiptId: "r1", r2Key: "k", contentType: "image/jpeg" });
  assert.equal(job.v, EXTRACTION_JOB_VERSION);
  assert.equal(job.receiptId, "r1");
  assert.equal(job.r2Key, "k");
  assert.equal(job.contentType, "image/jpeg");
  assert.ok(job.enqueuedAt);
});

test("isPendingProcessing: queue states are pending, processed is not", () => {
  assert.equal(isPendingProcessing(receipt({ extraction_state: "queued" })), true);
  assert.equal(isPendingProcessing(receipt({ extraction_state: "processing" })), true);
  assert.equal(isPendingProcessing(receipt({ extraction_state: "captured" })), true);
  assert.equal(isPendingProcessing(receipt({ extraction_state: "processed" })), false);
  assert.equal(isPendingProcessing(receipt({ extraction_state: "failed" })), false);
});

test("isPendingProcessing: falls back to status when extraction_state absent", () => {
  assert.equal(isPendingProcessing(receipt({ status: "captured" })), true);
  assert.equal(isPendingProcessing(receipt({ status: "needs_review" })), false);
});

test("blockers: pending-processing and unreviewed are distinct blockers", () => {
  const receipts: ReceiptRecord[] = [
    receipt({ id: "a", status: "captured", extraction_state: "queued" }),
    receipt({ id: "b", status: "needs_review", extraction_state: "processed" }),
  ];
  const lines: AmexStatementLine[] = [];
  const blockers = computeExportBlockers(receipts, lines);

  const pending = blockers.find((b) => b.label === "Receipts pending processing");
  const unreviewed = blockers.find((b) => b.label === "Unreviewed receipts");

  assert.ok(pending, "expected a pending-processing blocker");
  assert.equal(pending!.count, 1);
  assert.equal(pending!.ctaLabel, "Process queue");

  assert.ok(unreviewed, "expected an unreviewed blocker");
  assert.equal(unreviewed!.count, 1);
});

test("blockers: a processed needs_review receipt is not counted as pending", () => {
  const receipts: ReceiptRecord[] = [
    receipt({ id: "b", status: "needs_review", extraction_state: "processed" }),
  ];
  const blockers = computeExportBlockers(receipts, []);
  assert.equal(blockers.find((b) => b.label === "Receipts pending processing"), undefined);
});
