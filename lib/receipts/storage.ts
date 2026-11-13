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

// ─── Derivatives (proof copies + renders) — versioned, immutable (0042) ─────
// Every NEW derivative write goes to a UNIQUE per-upload key and the bytes are
// uploaded immutably BEFORE the manifest switch. Old derivative objects are
// never overwritten or deleted: a manifest published by a sealed bundle lists
// the key it sealed with, and that object must stay byte-identical forever
// (the 0042 proof/render publication keeps old objects referenced by prior
// manifests intact; abandoned unreferenced objects are an accepted, bounded
// storage cost — cleanup is deliberately out of scope).
//
// Legacy rows may still point at the old STABLE keys (receipts/<id>/proof.<ext>
// / rendered.<ext>) — those are read like any other key and never rewritten.

/** Versioned key for a proof-copy upload: `receipts/<id>/proof-<uuid>.<ext>`. */
export function proofCopyVersionedKey(
  receiptId: string,
  ext: "jpg" | "pdf",
  version: string,
): string {
  return `receipts/${receiptId}/proof-${version}.${ext}`;
}

/** Versioned key for a render upload: `receipts/<id>/rendered-<uuid>.<ext>`. */
export function renderedVersionedKey(
  receiptId: string,
  ext: "pdf" | "png",
  version: string,
): string {
  return `receipts/${receiptId}/rendered-${version}.${ext}`;
}

/**
 * Immutable no-overwrite put for derivative objects (the same conditional
 * uploadOriginal uses): the precondition is evaluated atomically by R2 and a
 * collision (impossible for a fresh uuid key — an anomaly) fails loudly.
 */
export async function putDerivativeImmutable(
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const bucket = getReceiptsBucket();
  const result = await bucket.put(key, data, {
    httpMetadata: { contentType },
    customMetadata: retentionMetadata(),
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (result === null) {
    throw new Error(
      `R2 key collision: refusing to overwrite existing derivative at key "${key}".`,
    );
  }
}

/**
 * Immutable no-overwrite put for a bundle artifact in the archive bucket.
 * Every 0042 build stages into its own `exports/<month>/<id>/<buildId>/`
 * namespace, so a collision means an attempt is reusing a build id — refuse
 * rather than silently overwrite another build's object (uploadOriginal's
 * conditional pattern, applied to outputs).
 */
export async function putArchiveImmutable(
  key: string,
  data: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const bucket = getReceiptsArchiveBucket();
  const result = await bucket.put(key, data, {
    httpMetadata: { contentType },
    customMetadata: retentionMetadata(),
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (result === null) {
    throw new Error(
      `R2 key collision: refusing to overwrite existing archive object at key "${key}".`,
    );
  }
}

/** CSV-typed convenience wrapper for putArchiveImmutable. */
export async function archiveBundle(
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  await putArchiveImmutable(key, data, "text/csv; charset=utf-8");
}

export async function archiveManifest(
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  await putArchiveImmutable(key, data, "text/csv; charset=utf-8");
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

/**
 * No-overwrite conditional put for an AMEX statement original. Artifact keys
 * are uuid-based (generateAmexArtifactKey) so a collision is an anomaly —
 * refuse it rather than overwrite a source object a prior seal may retain
 * (seal boundary §D: AMEX originals are immutable source evidence).
 */
export async function uploadAmexArtifact(
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  const bucket = getReceiptsBucket();
  const result = await bucket.put(key, data, {
    httpMetadata: { contentType: "text/csv" },
    customMetadata: retentionMetadata(),
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (result === null) {
    throw new Error(
      `R2 key collision: refusing to overwrite existing AMEX artifact at key "${key}".`,
    );
  }
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
