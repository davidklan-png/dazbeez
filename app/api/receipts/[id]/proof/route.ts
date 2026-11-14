import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import {
  computeSha256Hex,
  proofCopyVersionedKey,
  putDerivativeImmutable,
} from "@/lib/receipts/storage";
import { newUuid, nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { isSealBoundaryConflict } from "@/lib/receipts/month-lock";
import { getReceiptsDb, getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

const PROCESSOR_ACTOR = "mlx-consumer@mac";

// Constant-time string compare so the processor key can't be probed by timing.
// (Mirrors app/api/receipts/[id]/extract/route.ts — same processor-key path.)
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let mismatch = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

// Accepted proof-derivative content types. The Mac consumer does all image
// work before posting: JPEGs are recompressed (resize 1600, q75, EXIF stripped)
// in consumer.py; PDFs pass through unchanged (rasterizing legal docs loses
// text). The Worker never transforms image bytes (CPU budget, no native codecs).
const ACCEPTED_PROOF_TYPES = new Map<string, "jpg" | "pdf">([
  ["image/jpeg", "jpg"],
  ["application/pdf", "pdf"],
]);

/**
 * POST /api/receipts/[id]/proof
 *
 * Stores a compact proof derivative (role `proof_copy`) generated on the Mac
 * consumer at ingest (ADR 0001 processor-key path). Lives in the live
 * RECEIPTS_BUCKET at a UNIQUE versioned key; the sealed proofs ZIP prefers it
 * over the original to keep the bundle small.
 *
 * Immutable publication (seal boundary 0042): the bytes upload first under a
 * fresh no-overwrite key, then the old current manifest row, the new row and
 * the audit switch in ONE D1 batch — a fence rejection (active build claim)
 * leaves the old manifest intact and the new object merely unreferenced. Old
 * derivative objects are never overwritten or deleted.
 *
 * Auth mirrors the extract endpoint: a valid `x-receipts-processor-key` header
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
    const ext = ACCEPTED_PROOF_TYPES.get(contentType);
    if (!ext) {
      return NextResponse.json(
        {
          error: `Unsupported proof content-type "${contentType}". Expected one of: ${[...ACCEPTED_PROOF_TYPES.keys()].join(", ")}.`,
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
      return NextResponse.json({ error: "Empty proof body." }, { status: 400 });
    }

    const sha256 = await computeSha256Hex(bytes);
    const sizeBytes = bytes.byteLength;
    // Seal boundary §D: every derivative write goes to a UNIQUE versioned key
    // with IMMUTABLE bytes — the old stable-key overwrite could clobber an
    // object still referenced by a sealed manifest's receipt_files row.
    const r2Key = proofCopyVersionedKey(id, ext, newUuid());
    const db = getReceiptsDb();
    const now = nowIso();

    // Upload the immutable object FIRST; then switch the current manifest
    // atomically. A fence rejection (active build claim on this receipt, DZ_*)
    // leaves the OLD manifest intact and the new object merely unreferenced —
    // no bytes of a sealed reference are ever rewritten.
    await putDerivativeImmutable(r2Key, bytes, contentType);
    await db.batch([
      db
        .prepare(
          `DELETE FROM receipt_files
           WHERE object_type = 'receipt' AND object_id = ? AND role = 'proof_copy'`,
        )
        .bind(id),
      db
        .prepare(
          `INSERT INTO receipt_files
            (id, object_type, object_id, role, r2_bucket, r2_key,
             original_filename, content_type, file_size_bytes, sha256_hash,
             uploaded_by, uploaded_at, is_original, created_at, updated_at)
           VALUES (?, 'receipt', ?, 'proof_copy', 'receipts', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .bind(
          newUuid(),
          id,
          r2Key,
          `proof.${ext}`,
          contentType,
          sizeBytes,
          sha256,
          actor,
          now,
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO receipt_audit_log
            (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
           VALUES (?, ?, 'receipt.proof_uploaded', 'receipt', ?, NULL, ?, ?)`,
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

    return NextResponse.json(
      { ok: true, r2Key, sha256, sizeBytes },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (isSealBoundaryConflict(error)) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Proof upload conflict." },
        { status: 409 },
      );
    }
    console.error("[api/receipts/[id]/proof] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proof upload failed." },
      { status: 500 },
    );
  }
}
