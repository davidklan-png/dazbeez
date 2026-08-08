import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { buildExtractionJob, enqueueExtractionJob } from "@/lib/receipts/queue";
import { getReceiptsDb, getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

const PROCESSOR_ACTOR = "mlx-consumer@mac";

// Constant-time string compare so the processor key can't be probed by timing.
// Mirrors /proof and /render (the same processor-key path).
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let mismatch = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

/**
 * POST /api/receipts/[id]/enqueue
 *
 * Recovery tool for receipts that were captured but never enqueued for MLX
 * extraction — the email-attachment promote path before its enqueue fix (3 rows
 * stranded 2026-08-03), or any future capture path that leaves a receipt at
 * extraction_state='captured' with extraction_enqueued_at IS NULL. Enqueues
 * exactly one extraction job and advances extraction_state captured → queued so
 * the Mac consumer drains it through the normal pipeline.
 *
 * NOT a general reprocess button. A strict 409 guard admits ONLY the genuine
 * orphan state (needs_render = 0 AND extraction_state = 'captured' AND
 * extraction_enqueued_at IS NULL). Anything else — already queued, processing,
 * processed, failed, or awaiting a Mac render — is rejected with the actual
 * state named, so the tool can neither re-enqueue a receipt the consumer is
 * mid-flight on nor bypass the render pipeline (render receipts enqueue via
 * /render once their derivative lands).
 *
 * Auth mirrors /render: a valid x-receipts-processor-key authenticates the Mac
 * consumer; otherwise a Clerk-authenticated human may call it. Unlike the
 * capture path, the enqueue here IS the whole point, so a queue send failure is
 * surfaced as 500 (not swallowed best-effort) and leaves the receipt at
 * 'captured' for a retry.
 */
export async function POST(request: Request, { params }: RouteContext) {
  try {
    const processorKey = getReceiptsProcessorKey();
    const presentedKey = request.headers.get("x-receipts-processor-key");
    const isProcessor =
      !!processorKey && !!presentedKey && timingSafeEqual(presentedKey, processorKey);
    const actor = isProcessor
      ? PROCESSOR_ACTOR
      : await requireReceiptsActor(request.headers);

    const { id } = await params;

    const receipt = await getReceiptRecord(id);
    if (!receipt || receipt.deleted_at) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    // Strict 409 guard: only the genuine orphan state is admittable.
    const needsRender = receipt.needs_render === 1;
    const state = receipt.extraction_state ?? "captured";
    const alreadyEnqueued = receipt.extraction_enqueued_at != null;
    if (needsRender || state !== "captured" || alreadyEnqueued) {
      return NextResponse.json(
        {
          error:
            "Receipt is not in the recoverable state " +
            "(requires needs_render=0 AND extraction_state='captured' AND extraction_enqueued_at IS NULL). " +
            `Actual: needs_render=${receipt.needs_render ?? 0}, ` +
            `extraction_state='${state}', ` +
            `extraction_enqueued_at=${receipt.extraction_enqueued_at ?? "null"}.`,
        },
        { status: 409 },
      );
    }

    // Job r2Key matches what /file serves and the consumer expects
    // (extraction_r2_key ?? original_r2_key); contentType is the original's.
    const r2Key = receipt.extraction_r2_key ?? receipt.original_r2_key;
    const contentType = receipt.original_content_type ?? "application/octet-stream";
    const now = nowIso();

    const enqueued = await enqueueExtractionJob(
      buildExtractionJob({ receiptId: id, r2Key, contentType, enqueuedAt: now }),
    );
    if (!enqueued) {
      // The enqueue is the whole point of this tool — a silent best-effort false
      // would defeat it. Surface a 500; the receipt stays at 'captured' for retry.
      return NextResponse.json(
        {
          error:
            "Extraction queue is unavailable or rejected the job; receipt left at 'captured'.",
        },
        { status: 500 },
      );
    }

    const db = getReceiptsDb();
    await db
      .prepare(
        `UPDATE receipt_records
           SET extraction_state = 'queued',
               extraction_enqueued_at = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .bind(now, now, id)
      .run();

    await createAuditEntry(db, {
      actor,
      action: "receipt.extraction_enqueued",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({
        r2Key,
        contentType,
        previousState: "captured",
        via: isProcessor ? "mlx_consumer" : "human",
      }),
    });

    return NextResponse.json(
      { ok: true, receiptId: id, extractionState: "queued" },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]/enqueue] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Enqueue failed." },
      { status: 500 },
    );
  }
}
