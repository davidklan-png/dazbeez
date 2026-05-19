import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import {
  summarizeOpenChecksForMonth,
  runComplianceChecksForReceipt,
} from "@/lib/receipts/compliance";
import {
  getComplianceSettings,
  ACCOUNTANT_DISCLAIMER_EN,
  ACCOUNTANT_DISCLAIMER_JA,
} from "@/lib/receipts/settings";
import { listReceiptRecords, listAmexLines } from "@/lib/receipts/db";

type RouteContext = { params: Promise<{ month: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireReceiptsActor(request.headers);
    const { month } = await params;

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "month must be in YYYY-MM format." },
        { status: 400 },
      );
    }

    const db = getReceiptsDb();
    const settings = await getComplianceSettings();

    // Refresh checks for every receipt in the month so the report reflects
    // current state. This is idempotent.
    const receipts = await listReceiptRecords({ month, limit: 1000 });
    for (const r of receipts) {
      try {
        await runComplianceChecksForReceipt(db, r.id, settings);
      } catch {
        // Per-receipt check failure shouldn't block the report.
      }
    }

    const summary = await summarizeOpenChecksForMonth(db, month);

    const lines = await listAmexLines(month);
    const missingReceipt = lines.filter(
      (l) => l.receipt_status === "missing_receipt",
    ).length;

    return NextResponse.json(
      {
        month,
        generatedAt: new Date().toISOString(),
        receiptCount: receipts.length,
        amexLineCount: lines.length,
        missingReceiptLines: missingReceipt,
        complianceSummary: summary,
        disclaimer: {
          en: ACCOUNTANT_DISCLAIMER_EN,
          ja: ACCOUNTANT_DISCLAIMER_JA,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/compliance/[month]] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Compliance report failed." },
      { status: 500 },
    );
  }
}
