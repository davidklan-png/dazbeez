import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getExport,
  finalizeExport,
  createExportRevision,
} from "@/lib/receipts/db";
import {
  buildExportBundle,
  validateMonthReadyForExport,
  computeEarlierOpenMonthWarnings,
} from "@/lib/receipts/month-closing";

type RouteContext = { params: Promise<{ month: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireReceiptsActor(request.headers);
    const { month } = await params;

    const exportRecord = await getExport(month);
    if (!exportRecord) {
      return NextResponse.json({ error: "Export not found." }, { status: 404 });
    }

    return NextResponse.json({ export: exportRecord }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/export/[month]] GET failed", error);
    return NextResponse.json({ error: "Failed to load export." }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { month } = await params;

    const url = new URL(request.url);
    const isCorrection = url.searchParams.get("correction") === "true";

    if (isCorrection) {
      // Read correction reason from JSON body. Body is optional only when
      // not a correction; for revisions the reason is required.
      let reason = "";
      try {
        const body = (await request.json()) as { correctionReason?: string };
        reason = body.correctionReason?.trim() ?? "";
      } catch {
        // No JSON body — fall through with empty reason which fails below.
      }
      if (!reason) {
        return NextResponse.json(
          { error: "correctionReason is required when creating a revision." },
          { status: 400 },
        );
      }
      try {
        const revision = await createExportRevision(month, reason, actor);
        return NextResponse.json(
          { ok: true, ...revision, month },
          { status: 201 },
        );
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Revision failed." },
          { status: 422 },
        );
      }
    }

    const exportRecord = await getExport(month);
    if (!exportRecord) {
      return NextResponse.json({ error: "Export not found." }, { status: 404 });
    }

    if (exportRecord.status === "finalized") {
      return NextResponse.json(
        { error: `Export for ${month} is already finalized.` },
        { status: 409 },
      );
    }

    if (!exportRecord.archive_r2_key || !exportRecord.manifest_r2_key || !exportRecord.archive_sha256) {
      return NextResponse.json(
        { error: "Export bundle has not been generated yet. POST to /api/receipts/export/month first." },
        { status: 400 },
      );
    }

    // validateMonthReadyForExport is the single authority — it includes the
    // finalized-reconciliation precondition. The redundant pre-check that
    // used to live here was dropped to keep both finalize paths identical.
    // Build the bundle once so the gate consumes it (avoids an internal rebuild).
    const bundle = await buildExportBundle(month);
    const blockers = await validateMonthReadyForExport(month, bundle);
    if (blockers.length > 0) {
      return NextResponse.json(
        { error: "Export blocked — resolve these issues first.", blockers },
        { status: 422 },
      );
    }

    await finalizeExport(
      exportRecord.id,
      exportRecord.archive_r2_key,
      exportRecord.manifest_r2_key,
      exportRecord.archive_sha256,
      actor,
      exportRecord.manifest_sha256 ?? undefined,
      exportRecord.proofs_r2_key ?? null,
      exportRecord.proofs_sha256 ?? null,
      exportRecord.payment_due_date ?? null,
      exportRecord.operator_message ?? null,
    );

    // A7: non-blocking warning when finalizing month M while an earlier
    // statement month is still open. A late cash/digital receipt dated in
    // that earlier month will cost a revision once it lands — operators
    // should know that before they walk away thinking the month is "done."
    const warnings = await computeEarlierOpenMonthWarnings(month);

    // Phase B (D1/D2): finalize SEALS. It no longer sends any email — delivery
    // is the operator's explicit POST /api/receipts/export/{month}/send (see
    // lib/receipts/delivery-state.ts + the send route). A freshly finalized
    // month therefore has delivery_state NULL (never attempted), distinct from
    // sealed_undelivered (attempted + failed). Nothing here closes the month
    // for reporting; that waits on a successful delivery.
    return NextResponse.json(
      { ok: true, month, finalized: true, warnings },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/export/[month]] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Finalization failed." },
      { status: 500 },
    );
  }
}
