import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord, updateReceiptRecord } from "@/lib/receipts/db";
import { getReceiptFile } from "@/lib/receipts/storage";
import { extractReceiptData } from "@/lib/receipts/extraction";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { MAX_RECEIPT_FILE_BYTES } from "@/lib/receipts/validation";

const EXTRACTION_MAX_BYTES = MAX_RECEIPT_FILE_BYTES;

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;

    // Reprocess mode: `?force=true` re-runs extraction and overwrites
    // machine-set fields, but ONLY on receipts not yet reviewed
    // (captured / needs_review). Reviewed+ receipts are never overwritten.
    const force = new URL(request.url).searchParams.get("force") === "true";

    const receipt = await getReceiptRecord(id);
    const db = getReceiptsDb();

    if (!receipt) {
      await createAuditEntry(db, {
        actor,
        action: "receipt.extraction_denied",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({ reason: "not_found" }),
      });
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    if (receipt.status === "exported" || receipt.status === "archived") {
      await createAuditEntry(db, {
        actor,
        action: "receipt.extraction_denied",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({ reason: "locked", status: receipt.status }),
      });
      return NextResponse.json(
        { error: `Receipt is ${receipt.status} and cannot be re-extracted.` },
        { status: 409 },
      );
    }

    if (receipt.original_size_bytes > EXTRACTION_MAX_BYTES) {
      await createAuditEntry(db, {
        actor,
        action: "receipt.extraction_denied",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({
          reason: "file_too_large",
          sizeBytes: receipt.original_size_bytes,
          limitBytes: EXTRACTION_MAX_BYTES,
        }),
      });
      return NextResponse.json(
        {
          error:
            "Receipt image is too large for OCR extraction (max 5 MB). Please resize and re-upload.",
        },
        { status: 413 },
      );
    }

    await createAuditEntry(db, {
      actor,
      action: "receipt.extraction_requested",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({ sizeBytes: receipt.original_size_bytes }),
    });

    const file = await getReceiptFile(receipt.original_r2_key);
    if (!file) {
      return NextResponse.json({ error: "Receipt file not found in storage." }, { status: 404 });
    }

    const reader = file.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const imageBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      imageBytes.set(chunk, offset);
      offset += chunk.length;
    }

    let result;
    try {
      result = await extractReceiptData(imageBytes, file.contentType);
    } catch (extractionError) {
      await createAuditEntry(db, {
        actor,
        action: "receipt.extraction_failed",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({
          error: extractionError instanceof Error ? extractionError.message : String(extractionError),
        }),
      });
      throw extractionError;
    }

    // Default: only populate fields that are currently empty — never overwrite
    // confirmed data. With `force` on a pre-review receipt, re-extracted values
    // replace earlier machine guesses (e.g. a bad merchant from a noisy photo).
    const reprocessable = receipt.status === "captured" || receipt.status === "needs_review";
    const overwrite = force && reprocessable;
    const canSet = (current: unknown) => overwrite || current === null || current === undefined || current === "";

    const updates: Parameters<typeof updateReceiptRecord>[1] = {
      extractionJson: JSON.stringify(result),
    };

    if (canSet(receipt.transaction_date) && result.transactionDate) {
      updates.transactionDate = result.transactionDate;
    }
    if (canSet(receipt.merchant) && result.merchant) {
      updates.merchant = result.merchant;
    }
    if (canSet(receipt.amount_minor) && result.amountMinor !== null) {
      updates.amountMinor = result.amountMinor;
    }
    if (result.currency && receipt.currency === "JPY") {
      updates.currency = result.currency;
    }
    if ((overwrite || receipt.expense_type === "UNKNOWN") && result.expenseType) {
      updates.expenseType = result.expenseType;
    }
    if (canSet(receipt.business_purpose) && result.businessPurpose) {
      updates.businessPurpose = result.businessPurpose;
    }
    if (canSet(receipt.tax_amount_minor) && result.taxAmountMinor != null) {
      updates.taxAmountMinor = result.taxAmountMinor;
    }
    if (canSet(receipt.tax_rate) && result.taxRate) {
      updates.taxRate = result.taxRate;
    }
    if (canSet(receipt.invoice_registration_number) && result.invoiceRegistrationNumber) {
      updates.invoiceRegistrationNumber = result.invoiceRegistrationNumber;
    }

    await updateReceiptRecord(id, updates, actor);

    await createAuditEntry(db, {
      actor,
      action: "receipt.extraction_completed",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({ provider: result.provider }),
    });

    return NextResponse.json({ ok: true, extracted: result, extractedAt: nowIso() }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof Error && error.message.includes("finalized reconciliation")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[api/receipts/[id]/extract] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Extraction failed." },
      { status: 500 },
    );
  }
}
