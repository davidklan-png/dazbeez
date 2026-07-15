import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import { getLatestFinalizedExport, listExports } from "@/lib/receipts/db";
import { buildExportBundle } from "@/lib/receipts/month-closing";
import { authorizeNotifyTest, composeFinalizeNoticeData, notifyAccountantOfFinalize } from "@/lib/receipts/notify";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";

export async function POST(request: Request) {
  try {
    let clerkActor: string | null = null;
    try { clerkActor = await requireReceiptsActor(request.headers); } catch { clerkActor = null; }
    const actor = authorizeNotifyTest(clerkActor);

    const url = new URL(request.url);
    let month = url.searchParams.get("month") ?? "";
    if (!month) {
      const body = (await request.json().catch(() => ({}))) as { month?: string };
      month = body.month?.trim() ?? "";
    }
    if (!month) {
      const all = await listExports();
      const fin = all.filter((e) => e.status === "finalized")
        .sort((a, b) => (b.finalized_at ?? "").localeCompare(a.finalized_at ?? ""));
      if (fin.length === 0) return NextResponse.json({ ok: false, error: "No finalized month to test against." }, { status: 404 });
      month = fin[0]!.export_month;
    }

    const exportRecord = await getLatestFinalizedExport(month);
    if (!exportRecord) return NextResponse.json({ ok: false, error: `No finalized export for ${month}.` }, { status: 404 });
    const bundle = await buildExportBundle(month);
    const data = composeFinalizeNoticeData(month, bundle, exportRecord);
    const result = await notifyAccountantOfFinalize(data, { test: true });

    await createAuditEntry(getReceiptsDb(), {
      actor, action: "export.notification_test", objectType: "export", objectId: exportRecord.id,
      newValueJson: stringifyJson(result.ok ? { month, ok: true } : { month, ok: false, error: result.error }),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    console.error("[api/receipts/notify/test] POST failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Test send failed." }, { status: 500 });
  }
}
