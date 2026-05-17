import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  createReconciliationDraft,
  deleteDraftReconciliation,
  finalizeReconciliation,
  getAmexArtifactByMonth,
  getFinalizedReconciliationForMonth,
  listAmexLineAttendeeNamesByMonth,
  listAmexLines,
  listAttendees,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { hashCsvContent } from "@/lib/receipts/export";
import { buildReconciliationManifestCsv, validateAmexLinesForSignoff } from "@/lib/receipts/reconciliation-signoff";
import { archiveManifest, deleteArchiveObject } from "@/lib/receipts/storage";

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

    const activeArtifact = await getAmexArtifactByMonth(month);

    // Validate: all lines must be resolved
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

    const blockers = validateAmexLinesForSignoff(amexLines, amexAttendees, receiptAttendeeMap);

    if (blockers.length > 0) {
      return NextResponse.json(
        { error: "Cannot sign off — resolve these issues first.", blockers },
        { status: 400 },
      );
    }

    // Build manifest CSV
    let manifestCsv = buildReconciliationManifestCsv(
      amexLines,
      receipts,
      amexAttendees,
      Object.fromEntries(receiptAttendeeMap),
    );
    const manifestSha256 = await hashCsvContent(manifestCsv);

    // Prepend header comments with self-hash and source artifact
    const headerLines: string[] = [
      `# manifest_sha256: ${manifestSha256}`,
    ];
    if (activeArtifact) {
      headerLines.push(`# source_artifact_id: ${activeArtifact.id}`);
      headerLines.push(`# source_artifact_sha256: ${activeArtifact.sha256_hash}`);
    }
    manifestCsv = headerLines.join("\n") + "\n" + manifestCsv;

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
          finalizeError.message.includes("UNIQUE"))
      ) {
        // Clean up draft row and uploaded manifest
        await deleteDraftReconciliation(reconciliationId).catch(() => {});
        await deleteArchiveObject(manifestR2Key).catch(() => {});

        return NextResponse.json(
          { error: `Reconciliation for ${month} was finalized by another request.` },
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
