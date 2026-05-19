import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getExport, finalizeExport, getFinalizedReconciliationForMonth } from "@/lib/receipts/db";
import { validateMonthReadyForExport } from "@/lib/receipts/month-closing";

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

    const reconciliation = await getFinalizedReconciliationForMonth(month);
    if (!reconciliation) {
      return NextResponse.json(
        {
          error: `Cannot finalize export: no finalized reconciliation for ${month}.`,
        },
        { status: 422 },
      );
    }

    const blockers = await validateMonthReadyForExport(month);
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
    );

    return NextResponse.json({ ok: true, month, finalized: true }, { status: 200 });
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
