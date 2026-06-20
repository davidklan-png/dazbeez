// Extraction queue (ADR 0001).
//
// The capture path enqueues one job per captured receipt. A durable Cloudflare
// Queue holds the job until the Mac's pull consumer drains it, runs the local
// MLX model, and writes results back via the extract endpoint. No AI runs in
// the Worker — this module only *produces* jobs.
//
// D1 `receipt_records.status = 'captured'` plus `extraction_state` is the
// user-facing mirror of queue state; the Queue is the durable source of truth
// for "processed exactly once, nothing silently dropped".

import { getReceiptsQueue } from "@/lib/cloudflare-runtime";

/** Current schema version for the job payload, so the consumer can branch. */
export const EXTRACTION_JOB_VERSION = 1 as const;

export interface ExtractionJob {
  v: typeof EXTRACTION_JOB_VERSION;
  receiptId: string;
  /** R2 key of the original image the consumer must fetch. */
  r2Key: string;
  contentType: string;
  /** ISO timestamp the job was enqueued (observability / age tracking). */
  enqueuedAt: string;
}

export function buildExtractionJob(input: {
  receiptId: string;
  r2Key: string;
  contentType: string;
  enqueuedAt?: string;
}): ExtractionJob {
  return {
    v: EXTRACTION_JOB_VERSION,
    receiptId: input.receiptId,
    r2Key: input.r2Key,
    contentType: input.contentType,
    enqueuedAt: input.enqueuedAt ?? new Date().toISOString(),
  };
}

/**
 * Enqueue an extraction job. Best-effort by design: if the queue binding is
 * missing or send fails, the receipt still exists in D1 at `status='captured'`
 * with `extraction_state='captured'`, so the reprocess/backfill path can pick
 * it up. Capture must never fail because the queue is unavailable.
 *
 * Returns true if the job was enqueued, false if it could not be (caller
 * records `extraction_state` accordingly).
 */
export async function enqueueExtractionJob(job: ExtractionJob): Promise<boolean> {
  const queue = getReceiptsQueue();
  if (!queue) return false;
  try {
    await queue.send(job);
    return true;
  } catch (error) {
    console.error("[receipts/queue] enqueue failed", error);
    return false;
  }
}
