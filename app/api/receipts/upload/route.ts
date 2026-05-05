import { NextResponse } from "next/server";
import {
  assertReceiptsAccessFromHeaders,
  getReceiptsActor,
} from "@/lib/receipts/auth";
import { validateReceiptFile } from "@/lib/receipts/validation";
import { generateR2Key, uploadOriginal } from "@/lib/receipts/storage";
import { createReceiptRecord } from "@/lib/receipts/db";
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
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);

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

    const bytes = await file.arrayBuffer();
    const sha256 = await sha256Hex(bytes);

    const tempId = crypto.randomUUID();
    const r2Key = generateR2Key(tempId, file.name, new Date().toISOString());

    await uploadOriginal(r2Key, bytes, file.type || "application/octet-stream");

    let receiptId: string;
    try {
      receiptId = await createReceiptRecord(
        {
          capturedBy: actor,
          source,
          originalFilename: file.name,
          paymentPath,
          expenseType: expenseType as import("@/lib/receipts/types").ExpenseType | undefined,
          originalR2Key: r2Key,
          originalSha256: sha256,
          originalContentType: file.type || "application/octet-stream",
          originalSizeBytes: file.size,
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

    return NextResponse.json(
      {
        ok: true,
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
    console.error("[api/receipts/upload] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed." },
      { status: 500 },
    );
  }
}
