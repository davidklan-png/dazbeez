import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord, updateReceiptRecord } from "@/lib/receipts/db";
import {
  buildGuardedExtraction,
  type ModelExtractionFields,
} from "@/lib/receipts/extraction";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { getReceiptsDb, getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";
import type { ExtractionResult } from "@/lib/receipts/types";

type RouteContext = { params: Promise<{ id: string }> };

const PROCESSOR_ACTOR = "mlx-consumer@mac";

interface ApplyBody {
  /** OCR text produced by the Mac MLX model. Authoritative source of fields. */
  rawText?: string;
  /** Optional structured fields the model emitted alongside the OCR text. */
  fields?: ModelExtractionFields;
  /** Provider/model label for audit + provenance, e.g. "mlx_local:qwen2-vl-7b". */
  model?: string;
}

/**
 * Apply an extraction result to a receipt (ADR 0001).
 *
 * Two callers:
 *  - The Mac MLX consumer posts `{ rawText, fields, model }` with the processor
 *    key header. The Worker runs the regex guardrail over the model output,
 *    merges fields, advances captured → needs_review, and acks via 200.
 *  - A human "reprocess" (`?force=true`) with no body re-runs the regex parser
 *    over the OCR text already stored in extraction_json — Vision-free, exactly
 *    like scripts/reprocess-extraction.ts. No OCR runs in the Worker anymore.
 */
export async function POST(request: Request, { params }: RouteContext) {
  try {
    // Auth: the Mac consumer authenticates with a shared processor key; humans
    // go through CF Access / basic auth as before.
    const processorKey = getReceiptsProcessorKey();
    const presentedKey = request.headers.get("x-receipts-processor-key");
    const isProcessor = Boolean(processorKey) && presentedKey === processorKey;
    const actor = isProcessor
      ? PROCESSOR_ACTOR
      : await requireReceiptsActor(request.headers);

    const { id } = await params;
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";

    const body = (await request.json().catch(() => null)) as ApplyBody | null;

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

    // Reviewed-and-beyond receipts are never machine-overwritten.
    if (receipt.status !== "captured" && receipt.status !== "needs_review") {
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

    // Resolve the OCR text: fresh from the model, else the text already stored.
    let rawText = body?.rawText?.trim() || "";
    if (!rawText && receipt.extraction_json) {
      try {
        const prior = JSON.parse(receipt.extraction_json) as Partial<ExtractionResult>;
        rawText = (prior.rawText ?? "").trim();
      } catch {
        /* ignore malformed prior extraction */
      }
    }

    if (!rawText) {
      await createAuditEntry(db, {
        actor,
        action: "receipt.extraction_denied",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({ reason: "no_ocr_text" }),
      });
      return NextResponse.json(
        {
          error:
            "No OCR text to apply. The Mac MLX consumer must post rawText, or a prior extraction must exist to reprocess.",
        },
        { status: 422 },
      );
    }

    await createAuditEntry(db, {
      actor,
      action: "receipt.extraction_requested",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({ via: isProcessor ? "mlx_consumer" : "reprocess" }),
    });

    const provider = body?.model || (isProcessor ? "mlx_local" : "regex_reprocess");
    const { result, discrepancies } = buildGuardedExtraction(
      rawText,
      body?.fields ?? {},
      provider,
    );

    // Field-merge: by default only fill empty fields (never clobber confirmed
    // data). `force` on a pre-review receipt replaces earlier machine guesses.
    const overwrite = force; // status already guaranteed captured/needs_review
    const canSet = (current: unknown) =>
      overwrite || current === null || current === undefined || current === "";

    const updates: Parameters<typeof updateReceiptRecord>[1] = {
      extractionJson: JSON.stringify({ ...result, discrepancies }),
      extractionState: "processed",
      extractionProcessedAt: nowIso(),
      extractionProcessor: provider,
      extractionAttempts: (receipt.extraction_attempts ?? 0) + 1,
    };

    // A captured receipt becomes review-ready once the model has run.
    if (receipt.status === "captured") {
      updates.status = "needs_review";
    }

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
    if (canSet(receipt.business_purpose) && result.businessPurpose) {
      updates.businessPurpose = result.businessPurpose;
    }
    if (canSet(receipt.tax_amount_minor) && result.taxAmountMinor != null) {
      updates.taxAmountMinor = result.taxAmountMinor;
    }
    if (canSet(receipt.tax_rate) && result.taxRate) {
      updates.taxRate = result.taxRate;
    }
    if (
      canSet(receipt.invoice_registration_number) &&
      result.invoiceRegistrationNumber
    ) {
      updates.invoiceRegistrationNumber = result.invoiceRegistrationNumber;
    }

    await updateReceiptRecord(id, updates, actor);

    await createAuditEntry(db, {
      actor,
      action: "receipt.extraction_completed",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({ provider, discrepancies }),
    });

    return NextResponse.json(
      { ok: true, extracted: result, discrepancies, extractedAt: nowIso() },
      { status: 200 },
    );
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
