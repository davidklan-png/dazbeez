import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getFinalizedReconciliationForMonth } from "@/lib/receipts/db";
import { getReceiptsArchiveBucket } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ month: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireReceiptsActor(request.headers);
    const { month } = await params;

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Invalid month format." }, { status: 400 });
    }

    const reconciliation = await getFinalizedReconciliationForMonth(month);
    if (!reconciliation || !reconciliation.manifest_r2_key) {
      return NextResponse.json(
        { error: "No finalized reconciliation found for this month." },
        { status: 404 },
      );
    }

    const bucket = getReceiptsArchiveBucket();
    const object = await bucket.get(reconciliation.manifest_r2_key);
    if (!object) {
      return NextResponse.json(
        { error: "Manifest file not found in storage." },
        { status: 404 },
      );
    }

    return new Response(object.body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="reconciliation-${month}-manifest.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/reconcile/[month]/manifest] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to download manifest." },
      { status: 500 },
    );
  }
}
