import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { newUuid, nowIso } from "@/lib/receipts/db-utils";
import type { ReceiptFile, ReceiptFileRole } from "@/lib/receipts/types";

export interface CreateReceiptFileInput {
  objectType: "receipt" | "amex_statement_artifact" | "export";
  objectId: string;
  role: ReceiptFileRole;
  r2Bucket: "receipts" | "archive";
  r2Key: string;
  originalFilename: string;
  contentType: string;
  fileSizeBytes: number;
  sha256Hash: string;
  uploadedBy: string;
  isOriginal: boolean;
}

export async function createReceiptFile(
  db: D1Database,
  input: CreateReceiptFileInput,
): Promise<string> {
  const id = newUuid();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO receipt_files
        (id, object_type, object_id, role, r2_bucket, r2_key,
         original_filename, content_type, file_size_bytes, sha256_hash,
         uploaded_by, uploaded_at, is_original, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.objectType,
      input.objectId,
      input.role,
      input.r2Bucket,
      input.r2Key,
      input.originalFilename,
      input.contentType,
      input.fileSizeBytes,
      input.sha256Hash,
      input.uploadedBy,
      now,
      input.isOriginal ? 1 : 0,
      now,
      now,
    )
    .run();
  return id;
}

export async function listFilesForObject(
  objectType: string,
  objectId: string,
): Promise<ReceiptFile[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT * FROM receipt_files
       WHERE object_type = ? AND object_id = ?
       ORDER BY is_original DESC, created_at ASC`,
    )
    .bind(objectType, objectId)
    .all<ReceiptFile>();
  return result.results ?? [];
}

export async function findFileBySha256(
  sha256: string,
): Promise<ReceiptFile | null> {
  const db = getReceiptsDb();
  return db
    .prepare(`SELECT * FROM receipt_files WHERE sha256_hash = ? LIMIT 1`)
    .bind(sha256)
    .first<ReceiptFile>();
}
