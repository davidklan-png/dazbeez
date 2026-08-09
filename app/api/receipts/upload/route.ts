import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  validateReceiptFile,
  VALID_SOURCES,
  deriveSourceType,
  isValidSource,
  type Source,
} from "@/lib/receipts/upload-policy";
import { generateR2Key, uploadOriginal } from "@/lib/receipts/storage";
import { captureReceipt } from "@/lib/receipts/capture";
import { ExportFinalizedError } from "@/lib/receipts/month-lock";
import { getReceiptsBucket } from "@/lib/cloudflare-runtime";
import type { PaymentPath } from "@/lib/receipts/types";

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const VALID_PAYMENT_PATHS: PaymentPath[] = ["AMEX", "CASH", "DIGITAL", "UNKNOWN"];

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A file is required." }, { status: 400 });
    }

    const validationError = validateReceiptFile(file);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    // Optional metadata — all default to UNKNOWN/null if not provided
    const rawPaymentPath = formData.get("paymentPath")?.toString().toUpperCase();
    const paymentPath: PaymentPath =
      rawPaymentPath && VALID_PAYMENT_PATHS.includes(rawPaymentPath as PaymentPath)
        ? (rawPaymentPath as PaymentPath)
        : "UNKNOWN";

    const expenseType = formData.get("expenseType")?.toString() || undefined;
    // source is required provenance — the capture client always sends one
    // (mobile_capture | desktop_upload). Reject rather than silently default,
    // since defaulting to "mobile_capture" previously mislabeled every desktop
    // upload (and corrupted its source_type classification downstream).
    const rawSource = formData.get("source")?.toString();
    if (!isValidSource(rawSource)) {
      return NextResponse.json(
        {
          error:
            "Invalid or missing 'source'. Expected one of: " +
            VALID_SOURCES.join(", ") +
            ".",
        },
        { status: 400 },
      );
    }
    const source: Source = rawSource;
    const contentType = file.type || "application/octet-stream";
    const sourceType = deriveSourceType(
      formData.get("sourceType")?.toString(),
      source,
      contentType,
    );

    const bytes = await file.arrayBuffer();
    const sha256 = await sha256Hex(bytes);

    const tempId = crypto.randomUUID();
    const r2Key = generateR2Key(tempId, file.name, new Date().toISOString());

    await uploadOriginal(r2Key, bytes, contentType);

    // ADR 0001 + backlog #18: captureReceipt is the single door — createReceiptRecord
    // (a) + the is_original manifest row (b) + enqueue (c), with manifest LOUD
    // (compensating delete on failure) and enqueue best-effort. Nothing else
    // imports createReceiptRecord (enforced by tests/receipts/capture-contract.test.ts).
    let capture: { receiptId: string; enqueued: boolean };
    try {
      capture = await captureReceipt({
        record: {
          capturedBy: actor,
          source,
          sourceType,
          originalFilename: file.name,
          paymentPath,
          expenseType: expenseType as import("@/lib/receipts/types").ExpenseType | undefined,
          originalR2Key: r2Key,
          originalSha256: sha256,
          originalContentType: contentType,
          originalSizeBytes: file.size,
          status: "captured",
        },
        file: { sha256, sizeBytes: file.size, contentType, filename: file.name },
        r2Strategy: { kind: "uploaded" },
        enqueue: true,
        actor,
      });
    } catch (captureError) {
      // captureReceipt handles manifest-failure rollback (hardDeleteReceipt +
      // r2Key delete) internally. For a createReceiptRecord failure there is no
      // receipt yet — clean up the object we uploaded.
      try {
        await getReceiptsBucket().delete(r2Key);
      } catch {
        console.error("[receipts/upload] R2 cleanup after capture failure", captureError);
      }
      throw captureError;
    }

    return NextResponse.json(
      {
        ok: true,
        receiptId: capture.receiptId,
        status: "captured",
        extractionState: capture.enqueued ? "queued" : "captured",
        pendingProcessing: true,
        sourceType,
        reviewUrl: `/receipts/review/${capture.receiptId}`,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof ExportFinalizedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[api/receipts/upload] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}
