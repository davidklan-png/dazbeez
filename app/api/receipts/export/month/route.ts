import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  listReceiptRecords,
  listAttendees,
  createExport,
  finalizeExport,
  getFinalizedReconciliationForMonth,
} from "@/lib/receipts/db";
import {
  buildMonthlyExportCsv,
  hashCsvContent,
  buildArchiveKey,
  buildManifestKey,
  buildManifestCsv,
  buildReadmeKey,
  buildExportReadme,
} from "@/lib/receipts/export";
import { archiveBundle, archiveManifest } from "@/lib/receipts/storage";
import { getCategoryByCode } from "@/lib/receipts/categories";
import { validateMonthReadyForExport } from "@/lib/receipts/month-closing";
import { getReceiptsDb, getReceiptsArchiveBucket } from "@/lib/cloudflare-runtime";
import { getAmexArtifactByMonth } from "@/lib/receipts/db";
import { retentionMetadata } from "@/lib/receipts/retention";
import type { ExportRow, ReceiptFile } from "@/lib/receipts/types";

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const body = (await request.json()) as { month?: string; finalize?: boolean };
    const month = body.month?.trim();

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "month must be in YYYY-MM format." },
        { status: 400 },
      );
    }

    // Load receipts for the month
    const receipts = await listReceiptRecords({ month, limit: 1000 });

    if (receipts.length === 0) {
      return NextResponse.json(
        { error: `No receipts found for ${month}.` },
        { status: 400 },
      );
    }

    // Load attendees for all receipts
    const attendeeMap = new Map<string, string[]>();
    for (const r of receipts) {
      const attendees = await listAttendees(r.id);
      if (attendees.length > 0) {
        attendeeMap.set(r.id, attendees.map((a) => a.attendee_name));
      }
    }

    // Build export rows
    const exportRows: ExportRow[] = receipts.map((r) => {
      const cat = getCategoryByCode(r.expense_category_code ?? "");
      return {
        receiptId: r.id,
        transactionDate: r.transaction_date,
        merchant: r.merchant,
        amountMinor: r.amount_minor,
        currency: r.currency,
        expenseType: r.expense_type,
        expenseCategoryCode: r.expense_category_code ?? null,
        expenseCategoryJa: cat?.jaName ?? null,
        expenseCategoryEn: cat?.enName ?? null,
        paymentPath: r.payment_path,
        businessPurpose: r.business_purpose,
        attendees: attendeeMap.get(r.id) ?? [],
        status: r.status,
        originalR2Key: r.original_r2_key,
      };
    });

    // Export blocking validation — single authority is validateMonthReadyForExport
    // (lib/receipts/month-closing.ts). Do NOT inline a second finalize gate here;
    // any divergence between this route and /api/receipts/export/[month] reopens
    // the audit-9 drift where one path could finalize a month the other blocks.
    if (body.finalize) {
      const blockers = await validateMonthReadyForExport(month);
      if (blockers.length > 0) {
        return NextResponse.json(
          { error: "Export blocked — resolve these issues first.", blockers },
          { status: 422 },
        );
      }
    }

    // Generate CSV and hash
    const csv = buildMonthlyExportCsv(exportRows, attendeeMap);
    const sha256 = await hashCsvContent(csv);

    // Create or retrieve export record
    const exportId = await createExport(month, actor);
    const archiveKey = buildArchiveKey(month, exportId);
    const manifestKey = buildManifestKey(month, exportId);

    // Upload CSV to archive bucket
    const encoder = new TextEncoder();
    await archiveBundle(archiveKey, encoder.encode(csv).buffer as ArrayBuffer);

    // When finalizing, include reconciliation manifest reference in the export manifest
    const reconciliation = body.finalize
      ? await getFinalizedReconciliationForMonth(month)
      : null;

    // Gather all file-manifest entries for receipts included in this export
    // plus the AMEX statement artifact. This builds the per-file SHA-256
    // section of the manifest so an accountant can verify every artifact.
    const db = getReceiptsDb();
    const includedReceiptIds = receipts.map((r) => r.id);
    const fileRows: ReceiptFile[] = [];
    if (includedReceiptIds.length > 0) {
      const CHUNK_SIZE = 90;
      for (let i = 0; i < includedReceiptIds.length; i += CHUNK_SIZE) {
        const chunk = includedReceiptIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const result = await db
          .prepare(
            `SELECT * FROM receipt_files
             WHERE object_type = 'receipt' AND object_id IN (${placeholders})`,
          )
          .bind(...chunk)
          .all<ReceiptFile>();
        fileRows.push(...(result.results ?? []));
      }
    }
    const amexArtifact = await getAmexArtifactByMonth(month);
    const generatedAt = new Date().toISOString();

    // Generate and upload manifest
    const manifest = buildManifestCsv(
      exportId,
      month,
      archiveKey,
      sha256,
      exportRows.length,
      generatedAt,
      reconciliation
        ? {
            id: reconciliation.id,
            manifestR2Key: reconciliation.manifest_r2_key ?? "",
            manifestSha256: reconciliation.manifest_sha256 ?? "",
          }
        : null,
      {
        files: fileRows,
        amexArtifact: amexArtifact
          ? {
              r2Key: amexArtifact.r2_key,
              sha256Hash: amexArtifact.sha256_hash,
              originalFilename: amexArtifact.original_filename ?? "",
            }
          : null,
      },
    );
    const manifestBytes = encoder.encode(manifest);
    const manifestSha256 = await hashCsvContent(manifest);
    await archiveManifest(manifestKey, manifestBytes.buffer as ArrayBuffer);

    // README accompanies every bundle. Disclaimer text + revision context.
    const readme = buildExportReadme({
      exportId,
      month,
      rowCount: exportRows.length,
      generatedAt,
      exportRevision: 1,
      archiveSha256: sha256,
      manifestSha256,
    });
    const readmeKey = buildReadmeKey(month, exportId);
    await getReceiptsArchiveBucket().put(
      readmeKey,
      encoder.encode(readme).buffer as ArrayBuffer,
      {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: retentionMetadata(),
      },
    );

    // Auto-finalize if requested
    if (body.finalize) {
      await finalizeExport(
        exportId,
        archiveKey,
        manifestKey,
        sha256,
        actor,
        manifestSha256,
      );
    }

    return NextResponse.json(
      {
        exportId,
        month,
        rowCount: exportRows.length,
        sha256,
        manifestSha256,
        archiveKey,
        manifestKey,
        readmeKey,
        finalized: body.finalize ?? false,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/export/month] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed." },
      { status: 500 },
    );
  }
}
