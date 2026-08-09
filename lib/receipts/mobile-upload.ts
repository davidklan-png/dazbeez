// Mobile-upload idempotency lookup.
//
// createMobileReceiptRecord — the second INSERT INTO receipt_records (raw, with
// device_id/client_capture_id/captured_at_client/upload_origin) — was FOLDED
// into createReceiptRecord (lib/receipts/db.ts) by backlog #18's capture
// contract merge. Those columns are now optional fields on CreateReceiptInput,
// written by the single insert path; captureReceipt (lib/receipts/capture.ts)
// is the one door. This module keeps only the idempotency lookup the mobile
// route uses for its pre-check + race handling.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";

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
