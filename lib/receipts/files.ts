import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { D1_ID_CHUNK_SIZE, newUuid, nowIso } from "@/lib/receipts/db-utils";
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

/**
 * The export build's ONE file-manifest map (seal boundary §C/F7): receipt
 * files for the given ids, preserving the canonical selection order
 * (is_original DESC, created_at ASC) WITHIN each id — the same order
 * listFilesForObject has always used, so proof selection from the shared map
 * picks the same original/derivative the ordered helper would.
 */
export async function loadReceiptFilesMap(
  db: D1Database,
  objectIds: string[],
): Promise<Map<string, ReceiptFile[]>> {
  const out = new Map<string, ReceiptFile[]>();
  for (let i = 0; i < objectIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = objectIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT * FROM receipt_files
         WHERE object_type = 'receipt' AND object_id IN (${placeholders})
         ORDER BY object_id, is_original DESC, created_at ASC`,
      )
      .bind(...chunk)
      .all<ReceiptFile>();
    for (const f of result.results ?? []) {
      let arr = out.get(f.object_id);
      if (!arr) {
        arr = [];
        out.set(f.object_id, arr);
      }
      arr.push(f);
    }
  }
  return out;
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

// (Seal boundary 0042) The former stable-key derivative upsert helpers
// (deleteProofCopyForReceipt / deleteProcessedForReceipt) were removed with
// their callers: proof/render publication now writes a UNIQUE versioned key
// and switches the current manifest row inside ONE D1 batch (see the /proof
// and /render routes). Old objects are retained, never overwritten.

/**
 * Count receipt_files rows per receipt id (any role). Used by the proofs gate
 * (validateMonthReadyForExportCore) to flag a shipped receipt with ZERO file
 * rows — no original, no proof_copy → no proof to include → block finalize.
 * D1-only (the R2-existence check is the rebuild's layer-2 job, not the gate's).
 * Returns a Map keyed by receipt id; absent ids read as 0.
 */
export async function countReceiptFilesByObjectIds(
  db: D1Database,
  receiptIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (receiptIds.length === 0) return counts;
  // Chunk to respect D1's parameter limit per statement.
  for (let i = 0; i < receiptIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = receiptIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT object_id, COUNT(*) AS n
         FROM receipt_files
         WHERE object_type = 'receipt' AND object_id IN (${placeholders})
         GROUP BY object_id`,
      )
      .bind(...chunk)
      .all<{ object_id: string; n: number }>();
    for (const row of result.results ?? []) {
      counts.set(row.object_id, row.n);
    }
  }
  return counts;
}
