import { NextResponse } from "next/server";
import { getReceiptsBucket, getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createReceiptFile } from "@/lib/receipts/files";
import { generateR2Key, uploadOriginal } from "@/lib/receipts/storage";
import { requireMobileActor } from "@/lib/receipts/trusted-devices";
import { validateReceiptFile } from "@/lib/receipts/validation";
import {
  createMobileReceiptRecord,
  findMobileReceiptByIdempotency,
} from "@/lib/receipts/mobile-upload";
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

    let receiptId: string;
    try {
      receiptId = await createMobileReceiptRecord({
        actor: device.actor,
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
      });
    } catch (dbError) {
      // If the unique index races against a concurrent retry, surface the
      // already-saved receipt instead of leaving an orphan.
      const existingOnRace = await findMobileReceiptByIdempotency(
        device.deviceId,
        clientCaptureId,
      );
      try {
        await getReceiptsBucket().delete(r2Key);
      } catch {
        // best-effort
      }
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
      throw dbError;
    }

    try {
      await createReceiptFile(getReceiptsDb(), {
        objectType: "receipt",
        objectId: receiptId,
        role: "original",
        r2Bucket: "receipts",
        r2Key,
        originalFilename: file.name,
        contentType,
        fileSizeBytes: file.size,
        sha256Hash: sha256,
        uploadedBy: device.actor,
        isOriginal: true,
      });
    } catch (fileError) {
      console.error("[mobile/receipts/upload] file manifest write failed", fileError);
    }

    return NextResponse.json(
      {
        ok: true,
        duplicate: false,
        receiptId,
        status: "needs_review",
        reviewUrl: `/receipts/review/${receiptId}`,
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
    console.error("[api/mobile/receipts/upload] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}
