import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  listReceiptRecords,
  listReceiptRecordsByIds,
  listAttendees,
  createExport,
  finalizeExport,
  getFinalizedReconciliationForMonth,
  listAmexLines,
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
import { getCategoryByCode, requiresAttendees } from "@/lib/receipts/categories";
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

    // Export blocking validation — check AMEX lines and reconciliation before finalizing
    if (body.finalize) {
      const reconciliation = await getFinalizedReconciliationForMonth(month);
      if (!reconciliation) {
        return NextResponse.json(
          { error: `Cannot finalize export: no finalized reconciliation for ${month}. Sign off the reconciliation first.`, blockers: [`No finalized reconciliation for ${month}`] },
          { status: 422 },
        );
      }

      const amexLines = await listAmexLines(month);
      const matchedReceipts = await listReceiptRecordsByIds(
        amexLines
          .map((line) => line.matched_receipt_id)
          .filter((id): id is string => Boolean(id)),
      );
      const matchedAttendeeMap = new Map(attendeeMap);
      for (const receipt of matchedReceipts) {
        if (matchedAttendeeMap.has(receipt.id)) continue;
        const attendees = await listAttendees(receipt.id);
        if (attendees.length > 0) {
          matchedAttendeeMap.set(receipt.id, attendees.map((a) => a.attendee_name));
        }
      }
      const blockers: string[] = [];

      for (const line of amexLines) {
        if (!line.expense_category_code) {
          blockers.push(`Line ${line.id}: missing expense category`);
        }
        if (line.receipt_status === "missing_receipt" && !line.receipt_missing_reason) {
          blockers.push(`Line ${line.id}: missing receipt without reason`);
        }
        if (requiresAttendees(line.expense_category_code)) {
          const linkedReceipt = line.matched_receipt_id
            ? matchedAttendeeMap.get(line.matched_receipt_id)
            : null;
          if (!linkedReceipt || linkedReceipt.length === 0) {
            blockers.push(`Line ${line.id}: ${getCategoryByCode(line.expense_category_code ?? "")?.jaName ?? line.expense_category_code} requires attendees`);
          }
        }
        if (line.business_trip_status === "candidate") {
          blockers.push(`Line ${line.id}: unresolved business trip candidate`);
        }
        if (line.re_review_needed) {
          blockers.push(`Line ${line.id}: statement line changed after confirmation`);
        }
      }

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
