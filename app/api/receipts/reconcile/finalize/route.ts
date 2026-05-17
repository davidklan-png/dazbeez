import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  createReconciliationDraft,
  finalizeReconciliation,
  getFinalizedReconciliationForMonth,
  listAmexLineAttendeeNamesByMonth,
  listAmexLines,
  listAttendees,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { hashCsvContent } from "@/lib/receipts/export";
import { buildReconciliationManifestCsv } from "@/lib/receipts/reconciliation-signoff";
import { archiveManifest } from "@/lib/receipts/storage";
import { requiresAttendees } from "@/lib/receipts/categories";

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const body = (await request.json()) as { month?: string };
    const month = body.month?.trim();

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "month must be in YYYY-MM format." },
        { status: 400 },
      );
    }

    const alreadyFinalized = await getFinalizedReconciliationForMonth(month);
    if (alreadyFinalized) {
      return NextResponse.json(
        { error: `Reconciliation for ${month} is already finalized.` },
        { status: 409 },
      );
    }

    const amexLines = await listAmexLines(month);
    if (amexLines.length === 0) {
      return NextResponse.json(
        { error: `No AMEX lines found for ${month}.` },
        { status: 400 },
      );
    }

    // Validate: all lines must be resolved
    const blockers: string[] = [];
    const amexAttendees = await listAmexLineAttendeeNamesByMonth(month);
    const receipts = await listReceiptRecords({ paymentPath: "AMEX", limit: 200 });
    const receiptAttendeeMap = new Map<string, string[]>();
    const attendeeResults = await Promise.all(
      receipts.map(async (r) => {
        const att = await listAttendees(r.id);
        return att.length > 0 ? [r.id, att.map((a) => a.attendee_name)] as const : null;
      }),
    );
    for (const entry of attendeeResults) {
      if (entry) receiptAttendeeMap.set(entry[0], entry[1]);
    }

    for (const line of amexLines) {
      const label = `${line.transaction_date} ${line.merchant}`;

      if (line.match_status === "unmatched" || line.match_status === "matched") {
        blockers.push(`AMEX ${label}: unresolved match status (${line.match_status})`);
      }
      if (!line.expense_category_code) {
        blockers.push(`AMEX ${label}: missing expense category`);
      }
      if (
        line.receipt_status === "matched" &&
        (!line.matched_receipt_id || line.match_status !== "confirmed")
      ) {
        blockers.push(`AMEX ${label}: matched receipt is not confirmed`);
      }
      if (
        line.receipt_status === "missing_receipt" ||
        ((line.receipt_status === "no_receipt_required" ||
          line.receipt_status === "receipt_not_available") &&
          !line.receipt_missing_reason)
      ) {
        blockers.push(`AMEX ${label}: missing receipt requires a reason`);
      }
      if (requiresAttendees(line.expense_category_code)) {
        const linkedReceiptAttendees = line.matched_receipt_id
          ? receiptAttendeeMap.get(line.matched_receipt_id) ?? []
          : [];
        const directAmexAttendees = amexAttendees[line.id] ?? [];
        if (linkedReceiptAttendees.length === 0 && directAmexAttendees.length === 0) {
          blockers.push(`AMEX ${label}: requires attendees`);
        }
      }
      if (line.business_trip_status === "candidate") {
        blockers.push(`AMEX ${label}: unresolved business trip candidate`);
      }
    }

    if (blockers.length > 0) {
      return NextResponse.json(
        { error: "Cannot sign off — resolve these issues first.", blockers },
        { status: 400 },
      );
    }

    // Build manifest CSV
    const manifestCsv = buildReconciliationManifestCsv(
      amexLines,
      receipts,
      amexAttendees,
      Object.fromEntries(receiptAttendeeMap),
    );
    const manifestSha256 = await hashCsvContent(manifestCsv);

    const matchedCount = amexLines.filter((l) => l.match_status === "confirmed").length;
    const noReceiptCount = amexLines.filter((l) => l.match_status === "no_receipt").length;

    const reconciliationId = await createReconciliationDraft(
      month,
      amexLines.length,
      matchedCount,
      noReceiptCount,
      actor,
    );

    const manifestR2Key = `reconciliations/${month}/${reconciliationId}-manifest.csv`;

    // Upload manifest to archive bucket
    const encoder = new TextEncoder();
    await archiveManifest(manifestR2Key, encoder.encode(manifestCsv).buffer as ArrayBuffer);

    await finalizeReconciliation(
      reconciliationId,
      manifestR2Key,
      manifestSha256,
      actor,
    );

    return NextResponse.json(
      {
        id: reconciliationId,
        month,
        manifestR2Key,
        manifestSha256,
        lineCount: amexLines.length,
        matchedCount,
        noReceiptCount,
        finalized: true,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/reconcile/finalize] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Finalization failed." },
      { status: 500 },
    );
  }
}
