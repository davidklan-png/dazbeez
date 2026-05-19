import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  parseAmexNetanswer,
  netanswerLinesToImportInputs,
  detectBusinessTripCandidates,
} from "@/lib/receipts/validation";
import {
  importAmexLines,
  createAmexArtifact,
  getAmexArtifactBySha256,
  getAmexArtifactByMonth,
  getFinalizedReconciliationForMonth,
  markPreviousArtifactsReplaced,
  updateAmexArtifactStatus,
  createBusinessTripReports,
} from "@/lib/receipts/db";
import {
  generateAmexArtifactKey,
  uploadAmexArtifact,
  computeSha256Hex,
} from "@/lib/receipts/storage";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";

/*
 * AMEX CSV Import — Dedup Contract
 * ==================================
 * AMEX line identity is stable across re-imports. The dedup key is:
 *   (statement_month, amex_reference, cardholder_name)  — when amex_reference is present
 *   (statement_month, transaction_date, amount_minor, merchant, cardholder_name)  — fallback
 *
 * On re-upload for the same month, INSERT … ON CONFLICT DO UPDATE preserves
 * the row PK (id) and all reconciliation state (matched_receipt_id,
 * match_status, receipt_status, expense_category_code, business_trip_status,
 * category_status, receipt_missing_reason, business_trip_id) while refreshing
 * CSV-sourced fields (dates, merchant, amount, raw_json, etc.).
 *
 * Prior artifact records are marked import_status='replaced' after a
 * successful re-import.
 */

const MAX_CSV_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const formData = await request.formData();
    const file = formData.get("file");
    const statementMonth = formData.get("statementMonth")?.toString();
    const replaceConfirmed = formData.get("replaceConfirmed") === "true";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A CSV file is required." }, { status: 400 });
    }

    if (!statementMonth || !/^\d{4}-\d{2}$/.test(statementMonth)) {
      return NextResponse.json(
        { error: "statementMonth must be in YYYY-MM format." },
        { status: 400 },
      );
    }

    // Sanity-bound the statement month. The regex accepts 2099-12 / 1900-01
    // etc. which would land junk months in D1 and corrupt UIs that group by
    // month. Allow the current month plus one (Netアンサー sometimes posts the
    // upcoming statement a few days before the closing date) and 5 years back.
    {
      const now = new Date();
      const maxYearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 2).padStart(2, "0")}`;
      const minYearMonth = `${now.getUTCFullYear() - 5}-01`;
      // Normalize 13 → next-year-01 for the max comparison.
      const maxNormalized = now.getUTCMonth() + 2 > 12
        ? `${now.getUTCFullYear() + 1}-01`
        : maxYearMonth;
      if (statementMonth < minYearMonth || statementMonth > maxNormalized) {
        return NextResponse.json(
          {
            error: `statementMonth ${statementMonth} is outside the accepted range (${minYearMonth} … ${maxNormalized}).`,
          },
          { status: 400 },
        );
      }
    }

    if (file.size > MAX_CSV_BYTES) {
      return NextResponse.json(
        { error: "CSV file too large (max 5 MB)." },
        { status: 413 },
      );
    }

    const finalized = await getFinalizedReconciliationForMonth(statementMonth);
    if (finalized) {
      return NextResponse.json(
        { error: `Reconciliation for ${statementMonth} is finalized; AMEX import is locked.` },
        { status: 409 },
      );
    }

    const buffer = await file.arrayBuffer();
    const sha256 = await computeSha256Hex(buffer);

    // ── Duplicate file detection ────────────────────────────────────────────
    const existingBySha = await getAmexArtifactBySha256(sha256);
    if (existingBySha) {
      return NextResponse.json(
        {
          ok: true,
          duplicate: true,
          artifactId: existingBySha.id,
          statementMonth: existingBySha.statement_month,
          message: "This AMEX statement file has already been uploaded.",
          inserted: 0,
          updated: 0,
          unchanged: 0,
          transactionCount: existingBySha.transaction_count ?? 0,
          statementTotalCents: existingBySha.statement_total_amount_cents,
          cardName: existingBySha.card_name,
          paymentDueDate: existingBySha.payment_due_date,
        },
        { status: 200 },
      );
    }

    // ── Replacement check ───────────────────────────────────────────────────
    const previousArtifact = await getAmexArtifactByMonth(statementMonth);
    if (previousArtifact && !replaceConfirmed) {
      return NextResponse.json(
        {
          ok: false,
          needsReplaceConfirm: true,
          statementMonth,
          existingArtifactId: previousArtifact.id,
          message: `A statement for ${statementMonth} already exists. Replace it?`,
        },
        { status: 409 },
      );
    }

    // ── Parse CSV ───────────────────────────────────────────────────────────
    const {
      metadata,
      lines,
      skippedLines,
      validationErrors,
      parsedTotalCents,
      rowCount,
    } = parseAmexNetanswer(buffer, statementMonth);

    const importStatus = validationErrors.length > 0 ? "failed" : "parsed";

    // ── Upload artifact to R2 ───────────────────────────────────────────────
    const artifactId = crypto.randomUUID();
    const r2Key = generateAmexArtifactKey(statementMonth, artifactId, file.name);
    await uploadAmexArtifact(r2Key, buffer);

    // ── Save artifact record ────────────────────────────────────────────────
    const savedArtifactId = await createAmexArtifact({
      statementMonth,
      paymentDueDate: metadata.paymentDueDate,
      cardName: metadata.cardName,
      originalFilename: file.name,
      r2Key,
      encoding: metadata.encoding,
      sha256Hash: sha256,
      fileSizeBytes: file.size,
      uploadedBy: actor,
      statementTotalAmountCents: metadata.statementTotalCents,
      parsedTotalAmountCents: parsedTotalCents,
      transactionCount: lines.length,
      rowCount,
      validationErrors,
      importStatus,
    });

    // ── Return validation errors without importing lines ────────────────────
    if (validationErrors.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          artifactId: savedArtifactId,
          statementMonth,
          importStatus: "failed",
          validationErrors,
          skippedLines,
          transactionCount: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
        },
        { status: 422 },
      );
    }

    // ── Import line items ───────────────────────────────────────────────────
    const importInputs = netanswerLinesToImportInputs(
      lines,
      statementMonth,
      savedArtifactId,
      sha256,
    );

    const { inserted, updated, unchanged } = await importAmexLines(importInputs, actor);

    await updateAmexArtifactStatus(savedArtifactId, "parsed");

    // ── Mark previous artifact replaced (after successful import) ──────────
    if (previousArtifact) {
      await markPreviousArtifactsReplaced(statementMonth, savedArtifactId);
    }

    // ── Business trip candidate detection ───────────────────────────────────
    let businessTripCandidatesCount = 0;
    try {
      const db = getReceiptsDb();
      const inserted = await db
        .prepare(
          `SELECT id, cardholder_name, transaction_date, merchant
           FROM amex_statement_lines
           WHERE statement_artifact_id = ?
           ORDER BY raw_csv_line_number ASC`,
        )
        .bind(savedArtifactId)
        .all<{
          id: string;
          cardholder_name: string | null;
          transaction_date: string;
          merchant: string;
        }>();

      const realLines = (inserted.results ?? []).map((r) => ({
        id: r.id,
        cardholderName: r.cardholder_name,
        transactionDate: r.transaction_date,
        merchant: r.merchant,
      }));

      const candidates = detectBusinessTripCandidates(realLines);
      if (candidates.length > 0) {
        await createBusinessTripReports(candidates, actor);
        businessTripCandidatesCount = candidates.length;
      }
    } catch {
      // Non-fatal — trip detection failure does not block import
    }

    return NextResponse.json(
      {
        ok: true,
        artifactId: savedArtifactId,
        statementMonth,
        importStatus: "parsed",
        cardName: metadata.cardName,
        paymentDueDate: metadata.paymentDueDate,
        statementTotalCents: metadata.statementTotalCents,
        parsedTotalCents,
        transactionCount: lines.length,
        inserted,
        updated,
        unchanged,
        skippedLines,
        replaced: previousArtifact !== null,
        businessTripCandidates: businessTripCandidatesCount,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/amex/import] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed." },
      { status: 500 },
    );
  }
}
