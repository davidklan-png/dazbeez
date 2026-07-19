import { getReceiptsBucket, getReceiptsArchiveBucket } from "@/lib/cloudflare-runtime";
import { newUuid } from "@/lib/receipts/db-utils";
import { retentionMetadata } from "@/lib/receipts/retention";

/**
 * Collapse a user-supplied filename into a safe R2 path segment: strip to
 * `[A-Za-z0-9._-]`, cap at 100 chars. Shared by the receipts key builder
 * and the email-intake key builder (ADR 0011) so the two cannot drift on
 * sanitization rules.
 */
export function sanitizeFilenameForR2(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

export function generateR2Key(
  receiptId: string,
  filename: string,
  capturedAt: string,
): string {
  const date = capturedAt.slice(0, 10); // YYYY-MM-DD
  const [year, month] = date.split("-") as [string, string];
  const safe = sanitizeFilenameForR2(filename);
  return `receipts/${year}/${month}/${receiptId}/${newUuid()}-${safe}`;
}

export async function uploadOriginal(
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const bucket = getReceiptsBucket();

  // Conditional put — succeed only if no object exists at this key.
  // Replaces the previous head() + put() pair, which had a TOCTOU window
  // where two concurrent uploads could both observe "no object" and then
  // both put, with the second silently winning. With onlyIf the precondition
  // is evaluated atomically by R2 and the put returns null on conflict.
  const result = await bucket.put(key, data, {
    httpMetadata: { contentType },
    customMetadata: retentionMetadata(),
    onlyIf: { etagDoesNotMatch: "*" },
  });

  if (result === null) {
    throw new Error(
      `R2 key collision: refusing to overwrite existing object at key "${key}".`,
    );
  }
}

export async function getReceiptFile(
  key: string,
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const bucket = getReceiptsBucket();
  const object = await bucket.get(key);
  if (!object) return null;
  return {
    body: object.body,
    contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
  };
}

// ─── Proof-copy derivatives (PR 1) ─────────────────────────────────────────
// Compact proof image generated on the Mac consumer at ingest (resize 1600,
// JPEG q75; PDFs pass through). Stored in the LIVE receipts bucket under a
// STABLE per-receipt key so the proofs ZIP (sealed-bundle artifact) can prefer
// it over the original to keep the bundle small.

export function proofCopyR2Key(receiptId: string, ext: "jpg" | "pdf"): string {
  return `receipts/${receiptId}/proof.${ext}`;
}

/**
 * Overwrite-capable put for a proof-copy derivative. Unlike uploadOriginal
 * (which guards against collisions to protect originals), proof copies are
 * regenerable — re-ingest and `backfill_proof_copies.py --force` refresh them
 * in place. The caller deletes any prior proof_copy receipt_files row first so
 * the r2_key UNIQUE constraint still holds after the fresh insert.
 */
export async function putProofCopy(
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const bucket = getReceiptsBucket();
  await bucket.put(key, data, {
    httpMetadata: { contentType },
    customMetadata: retentionMetadata(),
  });
}

export async function archiveBundle(
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  const bucket = getReceiptsArchiveBucket();
  await bucket.put(key, data, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
    customMetadata: retentionMetadata(),
  });
}

export async function archiveManifest(
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  const bucket = getReceiptsArchiveBucket();
  await bucket.put(key, data, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
    customMetadata: retentionMetadata(),
  });
}

export function generateArchiveKey(
  month: string,
  exportId: string,
): string {
  return `exports/${month}/${exportId}-receipts.csv`;
}

export function generateManifestKey(
  month: string,
  exportId: string,
): string {
  return `exports/${month}/${exportId}-manifest.csv`;
}

// ─── AMEX statement artifact storage ──────────────────────────────────────

export function generateAmexArtifactKey(
  statementMonth: string,
  artifactId: string,
  originalFilename: string,
): string {
  const safe = originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return `amex-statements/${statementMonth}/${artifactId}-${safe}`;
}

export async function uploadAmexArtifact(
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  const bucket = getReceiptsBucket();
  await bucket.put(key, data, {
    httpMetadata: { contentType: "text/csv" },
    customMetadata: retentionMetadata(),
  });
}

// Best-effort R2 delete for a stale artifact object. Used by
// purgeFailedAmexArtifactsByHash when clearing out failed/replaced rows
// before re-inserting. Errors are caught by the caller — this helper is
// intentionally not try/catch'd so the caller can decide the failure
// policy (in practice: log and continue).
export async function deleteAmexArtifact(key: string): Promise<void> {
  const bucket = getReceiptsBucket();
  await bucket.delete(key);
}

export async function computeSha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  // Accept a Uint8Array (e.g. fflate's proofs-zip output, whose buffer is typed
  // ArrayBufferLike) as well as a plain ArrayBuffer. Cast to BufferSource for
  // the digest call — at runtime a Uint8Array is a valid BufferSource.
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function deleteArchiveObject(key: string): Promise<void> {
  const bucket = getReceiptsArchiveBucket();
  await bucket.delete(key);
}
