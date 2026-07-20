import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import {
  createReceiptFile,
  deleteProcessedForReceipt,
} from "@/lib/receipts/files";
import {
  computeSha256Hex,
  renderedR2Key,
  putRenderedDerivative,
} from "@/lib/receipts/storage";
import { enqueueExtractionJob, buildExtractionJob } from "@/lib/receipts/queue";
import { getReceiptsDb, getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

const PROCESSOR_ACTOR = "mlx-consumer@mac";

// Constant-time string compare so the processor key can't be probed by timing.
// Mirrors /proof and /file (the same processor-key path).
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let mismatch = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

// Accepted render-derivative content types. The Mac renderer (WeasyPrint, no JS
// engine, no network — ADR 0011 Phase B §3) emits PDF (preferred, text stays
// selectable) or PNG. The Worker never transforms bytes.
const ACCEPTED_RENDER_TYPES = new Map<string, "pdf" | "png">([
  ["application/pdf", "pdf"],
  ["image/png", "png"],
]);

/**
 * POST /api/receipts/[id]/render
 *
 * Deposits the Mac-rendered derivative (role `processed`, is_original=false) of
 * an email_body receipt's raw HTML/text body (ADR 0011 Phase B). Sets
 * receipt_records.extraction_r2_key to it, clears needs_render, and enqueues the
 * receipt for MLX extraction — so /file then transparently serves the rendered
 * image to both the consumer and the review UI.
 *
 * Idempotent upsert (mirrors /proof): a prior `processed` row is deleted and the
 * R2 object overwritten at the stable per-receipt key, so a re-render refreshes
 * the derivative without violating the r2_key UNIQUE constraint.
 *
 * Auth mirrors /proof and /file: a valid `x-receipts-processor-key` header
 * authenticates the Mac consumer; otherwise a Clerk-authenticated human may post.
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

    const contentType = (request.headers.get("content-type") ?? "")
      .toLowerCase()
      .split(";")[0]
      .trim();
    const ext = ACCEPTED_RENDER_TYPES.get(contentType);
    if (!ext) {
      return NextResponse.json(
        {
          error: `Unsupported render content-type "${contentType}". Expected one of: ${[...ACCEPTED_RENDER_TYPES.keys()].join(", ")}.`,
        },
        { status: 400 },
      );
    }

    const receipt = await getReceiptRecord(id);
    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0) {
      return NextResponse.json({ error: "Empty render body." }, { status: 400 });
    }

    const sha256 = await computeSha256Hex(bytes);
    const sizeBytes = bytes.byteLength;
    const r2Key = renderedR2Key(id, ext);
    const db = getReceiptsDb();
    const now = nowIso();

    // Upsert the derivative (r2_key UNIQUE): clear prior processed row, overwrite
    // the R2 object, insert the fresh row. R2 + D1 are not in one transaction.
    await deleteProcessedForReceipt(db, id);
    await putRenderedDerivative(r2Key, bytes, contentType);
    await createReceiptFile(db, {
      objectType: "receipt",
      objectId: id,
      role: "processed",
      r2Bucket: "receipts",
      r2Key,
      originalFilename: `rendered.${ext}`,
      contentType,
      fileSizeBytes: sizeBytes,
      sha256Hash: sha256,
      uploadedBy: actor,
      isOriginal: false,
    });

    // Enqueue for MLX extraction (best-effort, same contract as the upload
    // routes), then record extraction_r2_key, clear needs_render, and advance
    // extraction_state. The job's r2Key is the derivative; the consumer fetches
    // via /file/{id} which serves extraction_r2_key ?? original_r2_key.
    const enqueued = await enqueueExtractionJob(
      buildExtractionJob({ receiptId: id, r2Key, contentType, enqueuedAt: now }),
    );
    await db
      .prepare(
        `UPDATE receipt_records
           SET extraction_r2_key = ?,
               needs_render = 0,
               extraction_state = ?,
               extraction_enqueued_at = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .bind(r2Key, enqueued ? "queued" : "captured", enqueued ? now : null, now, id)
      .run();

    await createAuditEntry(db, {
      actor,
      action: "receipt.render_uploaded",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({
        r2Key,
        sha256,
        sizeBytes,
        contentType,
        enqueued,
        via: isProcessor ? "mlx_consumer" : "human",
      }),
    });

    return NextResponse.json(
      { ok: true, r2Key, sha256, sizeBytes, enqueued, extractionState: enqueued ? "queued" : "captured" },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]/render] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Render upload failed." },
      { status: 500 },
    );
  }
}
