import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import {
  computeSha256Hex,
  renderedVersionedKey,
  putDerivativeImmutable,
} from "@/lib/receipts/storage";
import { newUuid, nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { isSealBoundaryConflict } from "@/lib/receipts/month-lock";
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
    // Seal boundary §D: unique versioned key, immutable bytes, atomic manifest
    // switch. The old stable-key overwrite could clobber an object still
    // referenced by a sealed manifest.
    const r2Key = renderedVersionedKey(id, ext, newUuid());
    const db = getReceiptsDb();
    const now = nowIso();

    // Upload the immutable object first; the manifest switch, receipt pointer
    // update and audit commit as ONE D1 batch. A fence rejection (active build
    // claim, DZ_*) leaves the old manifest intact, needs_render untouched, and
    // the new object unreferenced.
    await putDerivativeImmutable(r2Key, bytes, contentType);
    await db.batch([
      db
        .prepare(
          `DELETE FROM receipt_files
           WHERE object_type = 'receipt' AND object_id = ? AND role = 'processed'`,
        )
        .bind(id),
      db
        .prepare(
          `INSERT INTO receipt_files
            (id, object_type, object_id, role, r2_bucket, r2_key,
             original_filename, content_type, file_size_bytes, sha256_hash,
             uploaded_by, uploaded_at, is_original, created_at, updated_at)
           VALUES (?, 'receipt', ?, 'processed', 'receipts', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(
          newUuid(),
          id,
          r2Key,
          `rendered.${ext}`,
          contentType,
          sizeBytes,
          sha256,
          actor,
          now,
          now,
          now,
        ),
      // Record the pointer and clear needs_render. extraction_state lands at
      // 'captured' (the honest pre-enqueue state); the enqueue runs only after
      // this batch is ADMITTED — queue work must not exist for a rejected
      // publication. A successful enqueue advances the state in a follow-up
      // best-effort write.
      db
        .prepare(
          `UPDATE receipt_records
             SET extraction_r2_key = ?,
                 needs_render = 0,
                 extraction_state = 'captured',
                 extraction_enqueued_at = NULL,
                 updated_at = ?
           WHERE id = ?`,
        )
        .bind(r2Key, now, id),
      db
        .prepare(
          `INSERT INTO receipt_audit_log
            (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
           VALUES (?, ?, 'receipt.render_uploaded', 'receipt', ?, NULL, ?, ?)`,
        )
        .bind(
          newUuid(),
          actor,
          id,
          stringifyJson({
            r2Key,
            sha256,
            sizeBytes,
            contentType,
            via: isProcessor ? "mlx_consumer" : "human",
          }),
          now,
        ),
    ]);

    // Publication admitted → best-effort enqueue (same contract as the upload
    // routes). Failure leaves the receipt at 'captured' (visible as
    // never-enqueued, recoverable by the ordinary enqueue path).
    let enqueued = false;
    try {
      enqueued = await enqueueExtractionJob(
        buildExtractionJob({ receiptId: id, r2Key, contentType, enqueuedAt: nowIso() }),
      );
    } catch (enqueueErr) {
      console.error("[api/receipts/[id]/render] extraction enqueue failed", enqueueErr);
      enqueued = false;
    }
    if (enqueued) {
      try {
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
      } catch (stateErr) {
        // The job is queued; only the state label lagged (e.g. a build claim
        // fenced this second write). The consumer processes the queued job
        // regardless; /extract heals the state. Never fail the upload for it.
        console.error("[api/receipts/[id]/render] post-enqueue state update failed", stateErr);
      }
    }

    return NextResponse.json(
      { ok: true, r2Key, sha256, sizeBytes, enqueued, extractionState: enqueued ? "queued" : "captured" },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (isSealBoundaryConflict(error)) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Render upload conflict." },
        { status: 409 },
      );
    }
    console.error("[api/receipts/[id]/render] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Render upload failed." },
      { status: 500 },
    );
  }
}
