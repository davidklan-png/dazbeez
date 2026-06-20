import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { validateReceiptFile } from "@/lib/receipts/validation";
import { generateR2Key, uploadOriginal } from "@/lib/receipts/storage";
import { createReceiptRecord, updateReceiptRecord } from "@/lib/receipts/db";
import { createReceiptFile } from "@/lib/receipts/files";
import { buildExtractionJob, enqueueExtractionJob } from "@/lib/receipts/queue";
import { getReceiptsBucket, getReceiptsDb } from "@/lib/cloudflare-runtime";
import type { PaymentPath, SourceType } from "@/lib/receipts/types";

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const VALID_PAYMENT_PATHS: PaymentPath[] = ["AMEX", "CASH", "DIGITAL", "UNKNOWN"];
const VALID_SOURCE_TYPES: SourceType[] = [
  "paper_scanned",
  "electronic_receipt",
  "digital_invoice",
  "credit_card_statement",
  "email_attachment",
  "manual_upload",
  "amex_csv",
];

function deriveSourceType(
  formValue: string | undefined,
  source: string,
  contentType: string,
): SourceType {
  if (formValue && VALID_SOURCE_TYPES.includes(formValue as SourceType)) {
    return formValue as SourceType;
  }
  // Heuristic fallback: mobile camera capture → paper scan; PDF →
  // electronic receipt; anything else → manual upload.
  if (source === "mobile_capture") return "paper_scanned";
  if (contentType === "application/pdf") return "electronic_receipt";
  return "manual_upload";
}

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
    const source = formData.get("source")?.toString() || "mobile_capture";
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

    let receiptId: string;
    try {
      receiptId = await createReceiptRecord(
        {
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
          // ADR 0001: capture path is async store-and-forward. The receipt lands
          // as 'captured' (pending processing) and an extraction job is enqueued
          // for the Mac MLX consumer to drain. No AI runs in the Worker.
          status: "captured",
        },
        actor,
      );
    } catch (dbError) {
      try {
        await getReceiptsBucket().delete(r2Key);
      } catch {
        console.error("[receipts/upload] R2 cleanup failed after DB error", dbError);
      }
      throw dbError;
    }

    // Manifest row for the original file. Failure to write the manifest row
    // does not roll back the upload — the receipt_records row already has the
    // hash + R2 key; the manifest row is additive metadata that downstream
    // compliance reports use.
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
        uploadedBy: actor,
        isOriginal: true,
      });
    } catch (fileError) {
      console.error("[receipts/upload] file manifest write failed", fileError);
    }

    // ADR 0001: enqueue the extraction job. Best-effort — if the queue binding
    // is missing or send fails, the receipt remains at status='captured' /
    // extraction_state='captured' and a backfill can enqueue it later. Capture
    // must never fail because the queue is unavailable.
    const enqueuedAt = new Date().toISOString();
    const enqueued = await enqueueExtractionJob(
      buildExtractionJob({ receiptId, r2Key, contentType, enqueuedAt }),
    );
    if (enqueued) {
      try {
        await updateReceiptRecord(
          receiptId,
          { extractionState: "queued", extractionEnqueuedAt: enqueuedAt },
          actor,
        );
      } catch (markError) {
        console.error("[receipts/upload] mark-queued failed", markError);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        receiptId,
        status: "captured",
        extractionState: enqueued ? "queued" : "captured",
        pendingProcessing: true,
        sourceType,
        reviewUrl: `/receipts/review/${receiptId}`,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/upload] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}
