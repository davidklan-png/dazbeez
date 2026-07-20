import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { unfinalizeReconciliation } from "@/lib/receipts/db";

// Minimal beta-review reopen (operator decision 2026-07-20): reverse a finalized
// AMEX reconciliation back to 'draft' so the month's receipts become editable
// again. Not the full ADR 0009 audited-reopen machinery. Mirrors the finalize
// route's auth + error-handling shape.

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const body = (await request.json()) as { month?: string; reason?: string };
    const month = body.month?.trim();
    const reason = body.reason?.trim();

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "month must be in YYYY-MM format." },
        { status: 400 },
      );
    }
    if (!reason) {
      return NextResponse.json(
        { error: "reason must be a non-empty string." },
        { status: 400 },
      );
    }

    await unfinalizeReconciliation(month, actor, reason);

    return NextResponse.json({ ok: true, month }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (
      error instanceof Error &&
      error.message.includes("No finalized reconciliation found")
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: 404 },
      );
    }
    console.error("[api/receipts/reconcile/unfinalize] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unfinalize failed." },
      { status: 500 },
    );
  }
}
