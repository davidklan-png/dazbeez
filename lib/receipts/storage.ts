import { getReceiptsBucket, getReceiptsArchiveBucket } from "@/lib/cloudflare-runtime";
import { newUuid } from "@/lib/receipts/db-utils";

export function generateR2Key(
  receiptId: string,
  filename: string,
  capturedAt: string,
): string {
  const date = capturedAt.slice(0, 10); // YYYY-MM-DD
  const [year, month] = date.split("-") as [string, string];
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return `receipts/${year}/${month}/${receiptId}/${newUuid()}-${safe}`;
}

export async function uploadOriginal(
  key: string,
  data: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const bucket = getReceiptsBucket();

  // Never overwrite an existing original
  const existing = await bucket.head(key);
  if (existing !== null) {
    throw new Error(
      `R2 key collision: refusing to overwrite existing object at key "${key}".`,
    );
  }

  await bucket.put(key, data, {
    httpMetadata: { contentType },
  });
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

export async function archiveBundle(
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  const bucket = getReceiptsArchiveBucket();
  await bucket.put(key, data, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
  });
}

export async function archiveManifest(
  key: string,
  data: ArrayBuffer,
): Promise<void> {
  const bucket = getReceiptsArchiveBucket();
  await bucket.put(key, data, {
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
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
  });
}

export async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
