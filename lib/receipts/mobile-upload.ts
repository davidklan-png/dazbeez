import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createAuditEntry } from "@/lib/receipts/audit";
import { newUuid, nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { retentionUntilIso } from "@/lib/receipts/retention";
import type { PaymentPath } from "@/lib/receipts/types";

export interface MobileReceiptInput {
  actor: string;
  deviceId: string;
  clientCaptureId: string;
  capturedAtClient: string | null;
  appVersion: string | null;
  note: string | null;
  paymentPath: PaymentPath;
  originalFilename: string;
  originalR2Key: string;
  originalSha256: string;
  originalContentType: string;
  originalSizeBytes: number;
}

export interface MobileReceiptIdempotencyHit {
  id: string;
  status: string;
}

export async function findMobileReceiptByIdempotency(
  deviceId: string,
  clientCaptureId: string,
): Promise<MobileReceiptIdempotencyHit | null> {
  const db = getReceiptsDb();
  const row = await db
    .prepare(
      `SELECT id, status FROM receipt_records
       WHERE device_id = ? AND client_capture_id = ?
       LIMIT 1`,
    )
    .bind(deviceId, clientCaptureId)
    .first<{ id: string; status: string }>();
  return row ?? null;
}

export async function createMobileReceiptRecord(input: MobileReceiptInput): Promise<string> {
  const db = getReceiptsDb();
  const id = newUuid();
  const now = nowIso();

  await db
    .prepare(
      // ADR 0001: mobile field captures are async like the web path — land as
      // status='captured' / extraction_state='captured' (pending processing).
      // The route enqueues a job and the Mac MLX consumer drains it. Setting
      // extraction_state explicitly is required: the column defaults to
      // 'captured', so any insert that omits it would otherwise read as pending
      // forever even on paths that never enqueue.
      `INSERT INTO receipt_records
        (id, captured_at, captured_by, source, original_filename,
         payment_path, expense_type,
         alcohol_present, attendees_required, status, extraction_state,
         original_r2_key, original_sha256, original_content_type, original_size_bytes,
         legacy, retention_until, legal_hold,
         source_type, preservation_status, qualified_invoice_status,
         device_id, client_capture_id, captured_at_client, upload_origin,
         currency,
         created_at, updated_at)
       VALUES
        (?, ?, ?, 'mobile_capture', ?,
         ?, 'UNKNOWN',
         0, 0, 'captured', 'captured',
         ?, ?, ?, ?,
         0, ?, 1,
         'paper_scanned', 'captured', 'not_checked',
         ?, ?, ?, 'mobile',
         'JPY',
         ?, ?)`,
    )
    .bind(
      id,
      now,
      input.actor,
      input.originalFilename,
      input.paymentPath,
      input.originalR2Key,
      input.originalSha256,
      input.originalContentType,
      input.originalSizeBytes,
      retentionUntilIso(now),
      input.deviceId,
      input.clientCaptureId,
      input.capturedAtClient,
      now,
      now,
    )
    .run();

  await createAuditEntry(db, {
    actor: input.actor,
    action: "receipt.uploaded",
    objectType: "receipt",
    objectId: id,
    newValueJson: stringifyJson({
      source: "mobile_capture",
      source_type: "paper_scanned",
      upload_origin: "mobile",
      payment_path: input.paymentPath,
      device_id: input.deviceId,
      client_capture_id: input.clientCaptureId,
      app_version: input.appVersion,
      note: input.note,
    }),
  });

  return id;
}
