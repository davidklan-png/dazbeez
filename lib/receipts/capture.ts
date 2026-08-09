// The capture-completeness contract (backlog #18). ONE door for every capture
// path: createReceiptRecord (a) → is_original receipt_files manifest row (b) →
// enqueued extraction job OR needs_render=1 (c). createReceiptRecord stays
// fiercely single-sourced and is imported ONLY here — enforced by
// tests/receipts/capture-contract.test.ts (that test is the real deliverable of
// #18: it protects the NEXT path, not the four current ones).
//
// Failure semantics are deliberately different (do not unify):
//   - manifest (b) fails → LOUD: hardDeleteReceipt + throw. A receipt with no
//     manifest row blocks month finalize; roll back the whole capture.
//   - enqueue (c) fails → BEST-EFFORT: capture never fails because the queue is
//     down. The #20 marker (extraction_enqueue_failed_at) is set so a queue
//     outage is distinguishable from a forgotten enqueue (backlog #20).

import { getReceiptsBucket, getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createReceiptRecord, hardDeleteReceipt } from "@/lib/receipts/db";
import { createReceiptFile, type CreateReceiptFileInput } from "@/lib/receipts/files";
import { buildExtractionJob, enqueueExtractionJob } from "@/lib/receipts/queue";
import { generateR2Key, uploadOriginal } from "@/lib/receipts/storage";
import { nowIso } from "@/lib/receipts/db-utils";
import type { CreateReceiptInput } from "@/lib/receipts/types";

/** Thrown when the receipt_records INSERT collides on the 0015 partial UNIQUE
 *  index (device_id + client_capture_id both set) — a mobile-capture retry the
 *  client already processed. The route catches this to return { duplicate: true }
 *  rather than an error. Distinct from CaptureManifestFailure so the route's
 *  catch cannot mistake a manifest failure for a race (#18 ii-c(b)). */
export class CaptureIdempotencyConflict extends Error {
  readonly kind = "CaptureIdempotencyConflict" as const;
  constructor(message = "mobile capture idempotency conflict") {
    super(message);
    this.name = "CaptureIdempotencyConflict";
  }
}

/** Thrown when the manifest (receipt_files) write fails after the receipt was
 *  created — the receipt is compensating-deleted (hardDeleteReceipt) first, then
 *  this is thrown. Typed so the route does NOT treat it as an idempotency race
 *  (#18 ii-c(b)): a manifest failure must surface as an error, not duplicate. */
export class CaptureManifestFailure extends Error {
  readonly kind = "CaptureManifestFailure" as const;
  constructor(
    message = "manifest write failed during capture",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CaptureManifestFailure";
  }
}

/** True when a D1 error is the 0015 mobile-idempotency UNIQUE collision. D1/SQLite
 *  surfaces it as "UNIQUE constraint failed: receipt_records.device_id, …".
 *  Exported so the race-vs-manifest classification (#18 ii-c(b)) is unit-testable. */
export function isMobileIdempotencyCollision(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint/i.test(msg) && /device_id|client_capture_id/i.test(msg);
}

/** Manifest metadata for the original file. The bytes themselves are either
 *  already in R2 (`uploaded`) or read from the intake object (`intake-copy`),
 *  so this carries only what the manifest row needs. */
export interface CaptureFile {
  sha256: string;
  sizeBytes: number;
  contentType: string;
  filename: string;
}

/** How the original lands at its final standard key.
 *  - `uploaded`: the caller already put the object in R2 at
 *    `record.originalR2Key` (the upload routes).
 *  - `intake-copy`: copy the object from `intakeKey` to the standard
 *    `receipts/{id}/...` key and patch `original_r2_key` (the promote paths).
 *    The caller owns the intake object's lifecycle (row flip + deletion). */
export type CaptureR2Strategy =
  | { kind: "uploaded" }
  | { kind: "intake-copy"; intakeKey: string };

export interface CaptureInput {
  record: CreateReceiptInput;
  file: CaptureFile;
  r2Strategy: CaptureR2Strategy;
  /** false only for the body path — it defers enqueue to /render (needs_render=1
   *  is seeded by createReceiptRecord from sourceType 'email_body'). Not a
   *  branch on source type; the caller states it. */
  enqueue: boolean;
  actor: string;
}

export interface CaptureResult {
  receiptId: string;
  /** true only when an enqueue was attempted and succeeded. False for the
   *  needs_render path (intentionally not enqueued). */
  enqueued: boolean;
  /** The standard key the manifest row (and, if enqueued, the job) reference. */
  r2Key: string;
}

/** Pure: the extraction-state mark for a capture, given the enqueue outcome.
 *  Encodes the #20 distinction: success → queued+enqueued_at; failure →
 *  captured+failed_at (the marker); not-attempted (needs_render) → captured with
 *  neither timestamp (createReceiptRecord's defaults already stand). */
export function decideCaptureMark(args: {
  attempted: boolean;
  enqueued: boolean;
  now: string;
}): {
  extractionState: "queued" | "captured";
  extractionEnqueuedAt: string | null;
  extractionEnqueueFailedAt: string | null;
} {
  if (!args.attempted) {
    return {
      extractionState: "captured",
      extractionEnqueuedAt: null,
      extractionEnqueueFailedAt: null,
    };
  }
  if (args.enqueued) {
    return {
      extractionState: "queued",
      extractionEnqueuedAt: args.now,
      extractionEnqueueFailedAt: null,
    };
  }
  return {
    extractionState: "captured",
    extractionEnqueuedAt: null,
    extractionEnqueueFailedAt: args.now,
  };
}

/** Pure: the is_original manifest row input. r2Key is the standard key (never a
 *  temporary intake/staging key); isOriginal is always true. */
export function buildCaptureFileInput(args: {
  receiptId: string;
  r2Key: string;
  file: CaptureFile;
  actor: string;
}): CreateReceiptFileInput {
  return {
    objectType: "receipt",
    objectId: args.receiptId,
    role: "original",
    r2Bucket: "receipts",
    r2Key: args.r2Key,
    originalFilename: args.file.filename,
    contentType: args.file.contentType,
    fileSizeBytes: args.file.sizeBytes,
    sha256Hash: args.file.sha256,
    uploadedBy: args.actor,
    isOriginal: true,
  };
}

async function compensate(receiptId: string, actor: string, reason: string): Promise<void> {
  try {
    await hardDeleteReceipt(receiptId, actor, reason);
  } catch (err) {
    console.error("[captureReceipt] compensating hardDeleteReceipt also failed — manual cleanup required", err);
  }
}

/**
 * The single capture door. Performs (a) createReceiptRecord → (b) manifest →
 * (c) enqueue-or-needs_render, with the R2 key resolved per `r2Strategy`.
 * Binding-coupled (D1 + R2 + Queue); the pure decisions are extracted above for
 * unit testing. Always satisfies the contract (a) ∧ (b) ∧ ((c₁) ∨ c₂)) — a path
 * cannot skip a step because there is no other path.
 */
export async function captureReceipt(input: CaptureInput): Promise<CaptureResult> {
  const db = getReceiptsDb();

  // (a) the receipt record — the sacred single insert path. A collision on the
  // 0015 mobile-idempotency index (device_id+client_capture_id) throws
  // CaptureIdempotencyConflict so the route returns { duplicate: true }; any
  // other DB error propagates.
  let receiptId: string;
  try {
    receiptId = await createReceiptRecord(input.record, input.actor);
  } catch (err) {
    if (isMobileIdempotencyCollision(err)) throw new CaptureIdempotencyConflict();
    throw err;
  }

  // Resolve the final standard key + (for intake-copy) move the object there.
  let r2Key: string;
  if (input.r2Strategy.kind === "uploaded") {
    r2Key = input.record.originalR2Key;
    if (!r2Key) {
      await compensate(receiptId, input.actor, "captureReceipt: uploaded strategy with no originalR2Key");
      throw new Error("captureReceipt: 'uploaded' strategy requires record.originalR2Key");
    }
  } else {
    const bucket = getReceiptsBucket();
    const intakeKey = input.r2Strategy.intakeKey;
    const obj = await bucket.get(intakeKey);
    if (!obj) {
      await compensate(receiptId, input.actor, `intake object missing during capture (${intakeKey})`);
      throw new Error(`captureReceipt: intake object missing at ${intakeKey}`);
    }
    const bytes = await obj.arrayBuffer();
    const now = nowIso();
    r2Key = generateR2Key(receiptId, input.file.filename, now);
    await uploadOriginal(r2Key, bytes, input.file.contentType);
    await db
      .prepare(`UPDATE receipt_records SET original_r2_key = ?, updated_at = ? WHERE id = ?`)
      .bind(r2Key, now, receiptId)
      .run();
  }

  // (b) the manifest row — LOUD. A receipt with no manifest row blocks finalize,
  // so roll back the whole capture on failure rather than leave a half-write.
  try {
    await createReceiptFile(
      db,
      buildCaptureFileInput({ receiptId, r2Key, file: input.file, actor: input.actor }),
    );
  } catch (fileError) {
    console.error("[captureReceipt] manifest write failed — compensating delete", fileError);
    try {
      await getReceiptsBucket().delete(r2Key);
    } catch (r2Err) {
      console.error("[captureReceipt] R2 cleanup after manifest failure also failed", r2Err);
    }
    await compensate(receiptId, input.actor, "manifest write failed during capture");
    throw new CaptureManifestFailure("manifest write failed during capture", fileError);
  }

  // (c) enqueue — BEST-EFFORT. Capture never fails because the queue is down;
  // a failure sets the #20 marker so it's distinguishable from "never tried".
  let enqueued = false;
  if (input.enqueue) {
    const now = nowIso();
    enqueued = await enqueueExtractionJob(
      buildExtractionJob({ receiptId, r2Key, contentType: input.file.contentType, enqueuedAt: now }),
    );
    const mark = decideCaptureMark({ attempted: true, enqueued, now });
    await db
      .prepare(
        `UPDATE receipt_records
           SET extraction_state = ?,
               extraction_enqueued_at = ?,
               extraction_enqueue_failed_at = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        mark.extractionState,
        mark.extractionEnqueuedAt,
        mark.extractionEnqueueFailedAt,
        now,
        receiptId,
      )
      .run();
  }
  // When !enqueue (needs_render), createReceiptRecord already seeded
  // extraction_state='captured' + needs_render=1 — nothing to update.

  return { receiptId, enqueued, r2Key };
}
