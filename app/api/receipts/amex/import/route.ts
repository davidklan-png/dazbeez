import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders, getReceiptsActor } from "@/lib/receipts/auth";
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

const MAX_CSV_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);

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

    if (file.size > MAX_CSV_BYTES) {
      return NextResponse.json(
        { error: "CSV file too large (max 5 MB)." },
        { status: 413 },
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
          imported: 0,
          skipped: 0,
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
    const { metadata, lines, validationErrors, parsedTotalCents, rowCount } =
      parseAmexNetanswer(buffer, statementMonth);

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
          transactionCount: 0,
          imported: 0,
          skipped: 0,
        },
        { status: 422 },
      );
    }

    // ── Mark previous artifact replaced ────────────────────────────────────
    if (previousArtifact) {
      await markPreviousArtifactsReplaced(statementMonth, savedArtifactId);
    }

    // ── Import line items ───────────────────────────────────────────────────
    const importInputs = netanswerLinesToImportInputs(
      lines,
      statementMonth,
      savedArtifactId,
      sha256,
    );

    const { imported, skipped } = await importAmexLines(importInputs, actor);

    await updateAmexArtifactStatus(savedArtifactId, "parsed");

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
        imported,
        skipped,
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
