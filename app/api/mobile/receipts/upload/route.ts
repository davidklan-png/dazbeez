import { NextResponse } from "next/server";
import { getReceiptsBucket } from "@/lib/cloudflare-runtime";
import { generateR2Key, uploadOriginal } from "@/lib/receipts/storage";
import { requireMobileActor } from "@/lib/receipts/trusted-devices";
import { validateReceiptFile } from "@/lib/receipts/validation";
import { findMobileReceiptByIdempotency } from "@/lib/receipts/mobile-upload";
import { captureReceipt, CaptureIdempotencyConflict } from "@/lib/receipts/capture";
import { ExportFinalizedError } from "@/lib/receipts/month-lock";
import type { PaymentPath } from "@/lib/receipts/types";

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const VALID_PAYMENT_HINTS = new Set(["AMEX", "CASH"]);

export async function POST(request: Request) {
  try {
    const device = await requireMobileActor(request.headers, "receipt:create");

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A file is required." }, { status: 400 });
    }
    const validationError = validateReceiptFile(file);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const clientCaptureId = formData.get("client_capture_id")?.toString().trim();
    if (!clientCaptureId) {
      return NextResponse.json(
        { error: "client_capture_id is required." },
        { status: 400 },
      );
    }
    const capturedAtClient =
      formData.get("captured_at_client")?.toString().trim() || null;
    const appVersion = formData.get("app_version")?.toString().slice(0, 32) || null;
    const note = formData.get("note")?.toString().slice(0, 1000) || null;
    const rawPaymentHint = formData.get("payment_hint")?.toString().toUpperCase();
    const paymentPath: PaymentPath = VALID_PAYMENT_HINTS.has(rawPaymentHint ?? "")
      ? (rawPaymentHint as PaymentPath)
      : "UNKNOWN";

    // Pre-R2 idempotency check. The browser route writes R2 before DB; the
    // mobile route inverts that order because retries are normal with an
    // offline queue and an R2 orphan on each retry would be expensive.
    const existing = await findMobileReceiptByIdempotency(
      device.deviceId,
      clientCaptureId,
    );
    if (existing) {
      return NextResponse.json(
        {
          ok: true,
          duplicate: true,
          receiptId: existing.id,
          status: existing.status,
          reviewUrl: `/receipts/review/${existing.id}`,
        },
        { status: 200 },
      );
    }

    const bytes = await file.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    const contentType = file.type || "image/jpeg";
    const tempId = crypto.randomUUID();
    const r2Key = generateR2Key(tempId, file.name, new Date().toISOString());

    await uploadOriginal(r2Key, bytes, contentType);

    // Backlog #18: captureReceipt is the single door. Mobile provenance
    // (device_id/client_capture_id/captured_at_client/upload_origin) + the
    // audit-only app_version/note flow through CreateReceiptInput; the 0015
    // partial UNIQUE index enforces idempotency AT INSERT, so a concurrent
    // retry surfaces as CaptureIdempotencyConflict (not a bare error the route
    // can't distinguish from a manifest failure — #18 ii-c(b)).
    let capture: { receiptId: string; enqueued: boolean };
    try {
      capture = await captureReceipt({
        record: {
          capturedBy: device.actor,
          source: "mobile_capture",
          sourceType: "paper_scanned",
          uploadOrigin: "mobile",
          deviceId: device.deviceId,
          clientCaptureId,
          capturedAtClient,
          appVersion,
          note,
          paymentPath,
          originalFilename: file.name,
          originalR2Key: r2Key,
          originalSha256: sha256,
          originalContentType: contentType,
          originalSizeBytes: file.size,
          status: "captured",
        },
        file: { sha256, sizeBytes: file.size, contentType, filename: file.name },
        r2Strategy: { kind: "uploaded" },
        enqueue: true,
        actor: device.actor,
      });
    } catch (err) {
      // Clean up the uploaded object (captureReceipt handles receipt rollback
      // for a manifest failure; for an idempotency collision the row belongs to
      // the concurrent winner). Then: collision + the winner exists → duplicate;
      // anything else (CaptureManifestFailure, other DB error) → surface as error.
      try {
        await getReceiptsBucket().delete(r2Key);
      } catch {
        // best-effort
      }
      if (err instanceof CaptureIdempotencyConflict) {
        const existingOnRace = await findMobileReceiptByIdempotency(
          device.deviceId,
          clientCaptureId,
        );
        if (existingOnRace) {
          return NextResponse.json(
            {
              ok: true,
              duplicate: true,
              receiptId: existingOnRace.id,
              status: existingOnRace.status,
              reviewUrl: `/receipts/review/${existingOnRace.id}`,
            },
            { status: 200 },
          );
        }
      }
      throw err;
    }

    return NextResponse.json(
      {
        ok: true,
        duplicate: false,
        receiptId: capture.receiptId,
        status: "captured",
        extractionState: capture.enqueued ? "queued" : "captured",
        pendingProcessing: true,
        reviewUrl: `/receipts/review/${capture.receiptId}`,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof Error && error.message.startsWith("Forbidden")) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ExportFinalizedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[api/mobile/receipts/upload] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}
