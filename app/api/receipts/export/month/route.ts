import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders, getReceiptsActor } from "@/lib/receipts/auth";
import {
  listReceiptRecords,
  listAttendees,
  createExport,
  finalizeExport,
} from "@/lib/receipts/db";
import {
  buildMonthlyExportCsv,
  hashCsvContent,
  buildArchiveKey,
  buildManifestKey,
  buildManifestCsv,
} from "@/lib/receipts/export";
import { archiveBundle, archiveManifest } from "@/lib/receipts/storage";
import type { ExportRow } from "@/lib/receipts/types";

export async function POST(request: Request) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);

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
    const exportRows: ExportRow[] = receipts.map((r) => ({
      receiptId: r.id,
      transactionDate: r.transaction_date,
      merchant: r.merchant,
      amountMinor: r.amount_minor,
      currency: r.currency,
      expenseType: r.expense_type,
      paymentPath: r.payment_path,
      businessPurpose: r.business_purpose,
      attendees: attendeeMap.get(r.id) ?? [],
      status: r.status,
      originalR2Key: r.original_r2_key,
    }));

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

    // Generate and upload manifest
    const manifest = buildManifestCsv(
      exportId,
      month,
      archiveKey,
      sha256,
      exportRows.length,
      new Date().toISOString(),
    );
    await archiveManifest(manifestKey, encoder.encode(manifest).buffer as ArrayBuffer);

    // Auto-finalize if requested
    if (body.finalize) {
      await finalizeExport(exportId, archiveKey, manifestKey, sha256, actor);
    }

    return NextResponse.json(
      {
        exportId,
        month,
        rowCount: exportRows.length,
        sha256,
        archiveKey,
        manifestKey,
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
