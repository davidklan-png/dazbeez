import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  createReconciliationDraft,
  finalizeReconciliation,
  getAmexArtifactByMonth,
  getFinalizedReconciliationForMonth,
  listAmexLineAttendeeNamesByMonth,
  listAmexLines,
  listAttendees,
  listPendingProcessingReceipts,
  listReceiptRecordsByIds,
} from "@/lib/receipts/db";
import { RECEIPT_BULK_LIMIT, hasReceiptBulkOverflow } from "@/lib/receipts/list-policy";
import { hashCsvContent } from "@/lib/receipts/export";
import { buildReconciliationManifestCsv, validateAmexLinesForSignoff } from "@/lib/receipts/reconciliation-signoff";
import { deriveStatementWindow, isReceiptInWindow } from "@/lib/receipts/statement-window";
import { archiveManifest, deleteArchiveObject } from "@/lib/receipts/storage";
import type { ReceiptRecord } from "@/lib/receipts/types";

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

    // ADR 0001 — hard gate: a period cannot be finalized while the extraction
    // queue still holds unprocessed receipts for its window. "Drain the queue
    // before close" is enforced, not advice. A captured-but-unprocessed receipt
    // has no field key yet, so it cannot be matched — without this gate a queue
    // backlog masquerades as missing receipts. Captured receipts have no date
    // yet, so isReceiptInWindow treats them as in-window (conservative).
    const window = deriveStatementWindow(amexLines, month);
    const pendingReceipts = await listPendingProcessingReceipts(RECEIPT_BULK_LIMIT + 1);
    if (hasReceiptBulkOverflow(pendingReceipts.length)) {
      return NextResponse.json(
        {
          error:
            `Cannot finalize ${month}: more than ${RECEIPT_BULK_LIMIT} receipts are still pending extraction. ` +
            `The statement window cannot be verified safely while the backlog exceeds the safety ceiling. ` +
            `Drain the Mac MLX consumer queue and retry.`,
          pendingProcessingAtLeast: pendingReceipts.length,
        },
        { status: 409 },
      );
    }
    const pendingInWindow = pendingReceipts.filter((r) => isReceiptInWindow(r, window));
    if (pendingInWindow.length > 0) {
      return NextResponse.json(
        {
          error:
            `Cannot finalize ${month}: ${pendingInWindow.length} receipt(s) are still pending extraction. ` +
            `Run the Mac MLX consumer to drain the queue, then retry.`,
          pendingProcessing: pendingInWindow.length,
        },
        { status: 409 },
      );
    }

    const activeArtifact = await getAmexArtifactByMonth(month);

    // Validate: all lines must be resolved
    const amexAttendees = await listAmexLineAttendeeNamesByMonth(month);
    const receiptIds = amexLines
      .map((line) => line.matched_receipt_id)
      .filter((id): id is string => Boolean(id));
    const receipts = await listReceiptRecordsByIds(receiptIds);
    const receiptMap = new Map<string, ReceiptRecord>(receipts.map((r) => [r.id, r]));
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

    const blockers = validateAmexLinesForSignoff(amexLines, amexAttendees, receiptAttendeeMap, receiptMap);

    if (blockers.length > 0) {
      return NextResponse.json(
        { error: "Cannot sign off — resolve these issues first.", blockers },
        { status: 400 },
      );
    }

    // Build manifest CSV
    const manifestBodyCsv = buildReconciliationManifestCsv(
      amexLines,
      receipts,
      amexAttendees,
      Object.fromEntries(receiptAttendeeMap),
    );
    const manifestBodySha256 = await hashCsvContent(manifestBodyCsv);

    // Prepend source metadata, then hash the exact object that is archived.
    const headerLines: string[] = [
      `# manifest_body_sha256: ${manifestBodySha256}`,
    ];
    if (activeArtifact) {
      headerLines.push(`# source_artifact_id: ${activeArtifact.id}`);
      headerLines.push(`# source_artifact_sha256: ${activeArtifact.sha256_hash}`);
    }
    const manifestCsv = headerLines.join("\n") + "\n" + manifestBodyCsv;
    const manifestSha256 = await hashCsvContent(manifestCsv);

    const matchedCount = amexLines.filter((l) => l.match_status === "confirmed").length;
    const noReceiptCount = amexLines.filter((l) => l.match_status === "no_receipt").length;

    const reconciliationId = await createReconciliationDraft(
      month,
      amexLines.length,
      matchedCount,
      noReceiptCount,
      actor,
      activeArtifact?.id ?? null,
    );

    const manifestR2Key = `reconciliations/${month}/${reconciliationId}-manifest.csv`;

    try {
      // Upload manifest to archive bucket
      const encoder = new TextEncoder();
      await archiveManifest(manifestR2Key, encoder.encode(manifestCsv).buffer as ArrayBuffer);

      // finalizeReconciliation now atomically cleans up this request's draft
      // row if it loses the finalize race (audit finding A2). The catch path
      // only needs to handle R2 cleanup of the just-uploaded manifest.
      await finalizeReconciliation(
        reconciliationId,
        manifestR2Key,
        manifestSha256,
        actor,
      );
    } catch (finalizeError) {
      // Unique constraint violation means another request finalized first
      if (
        finalizeError instanceof Error &&
        (finalizeError.message.includes("CONSTRAINT") ||
          finalizeError.message.includes("UNIQUE") ||
          finalizeError.message.includes("could not be finalized"))
      ) {
        // D1 cleanup is already atomic inside finalizeReconciliation; only
        // R2 needs post-commit cleanup. Don't swallow — log with signature
        // so a failure here is observable (audit finding A2).
        const warnings: string[] = [];
        try {
          await deleteArchiveObject(manifestR2Key);
        } catch (r2CleanupError) {
          console.error(
            `[finalize-cleanup-fail] month=${month} key=${manifestR2Key} reason=R2 delete after race-loser threw`,
            r2CleanupError,
          );
          warnings.push(
            `R2 cleanup incomplete for ${manifestR2Key} — see logs.`,
          );
        }

        return NextResponse.json(
          {
            error: `Reconciliation for ${month} was finalized by another request.`,
            warnings,
          },
          { status: 409 },
        );
      }
      throw finalizeError;
    }

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
        warnings: [] as string[],
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
