import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders, getReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord, updateReceiptRecord } from "@/lib/receipts/db";
import { getReceiptFile } from "@/lib/receipts/storage";
import { extractReceiptData } from "@/lib/receipts/extraction";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";

const EXTRACTION_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);
    const { id } = await params;

    const receipt = await getReceiptRecord(id);
    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    if (receipt.status === "exported" || receipt.status === "archived") {
      return NextResponse.json(
        { error: `Receipt is ${receipt.status} and cannot be re-extracted.` },
        { status: 409 },
      );
    }

    if (receipt.original_size_bytes > EXTRACTION_MAX_BYTES) {
      return NextResponse.json(
        {
          error:
            "Receipt image is too large for AI extraction (max 5 MB). Please resize and re-upload.",
        },
        { status: 413 },
      );
    }

    const db = getReceiptsDb();

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

    // Only populate fields that are currently null/UNKNOWN — never overwrite confirmed data
    const updates: Parameters<typeof updateReceiptRecord>[1] = {
      extractionJson: JSON.stringify(result),
    };

    if (!receipt.transaction_date && result.transactionDate) {
      updates.transactionDate = result.transactionDate;
    }
    if (!receipt.merchant && result.merchant) {
      updates.merchant = result.merchant;
    }
    if (receipt.amount_minor === null && result.amountMinor !== null) {
      updates.amountMinor = result.amountMinor;
    }
    if (result.currency && receipt.currency === "JPY") {
      updates.currency = result.currency;
    }
    if (receipt.expense_type === "UNKNOWN" && result.expenseType) {
      updates.expenseType = result.expenseType;
    }
    if (!receipt.business_purpose && result.businessPurpose) {
      updates.businessPurpose = result.businessPurpose;
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
    console.error("[api/receipts/[id]/extract] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Extraction failed." },
      { status: 500 },
    );
  }
}
