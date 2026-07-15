import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import { createReceiptFile, deleteProofCopyForReceipt } from "@/lib/receipts/files";
import {
  computeSha256Hex,
  proofCopyR2Key,
  putProofCopy,
} from "@/lib/receipts/storage";
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
 * RECEIPTS_BUCKET at a stable per-receipt key; the sealed proofs ZIP prefers it
 * over the original to keep the bundle small.
 *
 * Idempotent upsert: a prior proof_copy row for the receipt is deleted and the
 * R2 object overwritten, so re-ingest / backfill --force refreshes the
 * derivative without violating the r2_key UNIQUE constraint.
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
    const r2Key = proofCopyR2Key(id, ext);
    const db = getReceiptsDb();

    // Upsert: clear any prior proof_copy row (r2_key UNIQUE), overwrite the R2
    // object, then insert the fresh row. R2 + D1 are not in one transaction —
    // if the insert fails after the put, the orphaned object is harmless (a
    // later retry overwrites it at the same stable key).
    await deleteProofCopyForReceipt(db, id);
    await putProofCopy(r2Key, bytes, contentType);
    await createReceiptFile(db, {
      objectType: "receipt",
      objectId: id,
      role: "proof_copy",
      r2Bucket: "receipts",
      r2Key,
      originalFilename: `proof.${ext}`,
      contentType,
      fileSizeBytes: sizeBytes,
      sha256Hash: sha256,
      uploadedBy: actor,
      isOriginal: false,
    });

    await createAuditEntry(db, {
      actor,
      action: "receipt.proof_uploaded",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({
        r2Key,
        sha256,
        sizeBytes,
        contentType,
        via: isProcessor ? "mlx_consumer" : "human",
      }),
    });

    return NextResponse.json(
      { ok: true, r2Key, sha256, sizeBytes },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]/proof] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Proof upload failed." },
      { status: 500 },
    );
  }
}
