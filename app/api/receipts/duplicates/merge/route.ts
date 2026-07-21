import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { applyDuplicateMerge, MergeError } from "@/lib/receipts/duplicate-merge";
import type { PreservationField } from "@/lib/receipts/duplicate-resolution-policy";

// POST /api/receipts/duplicates/merge
// Server-authoritative duplicate-merge: resolves target-only/conflicting
// accounting data onto the retained canonical receipt BEFORE purge. Nothing is
// copied automatically; the operator provides a resolution plan. Source receipts
// remain untouched. Never performs purge.
export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json()) as {
      retainedReceiptId?: string;
      retainedExpectedUpdatedAt?: string;
      sources?: Array<{ receiptId: string; expectedUpdatedAt: string }>;
      resolutionPlan?: Array<{
        field: PreservationField;
        action: "copy_from_source" | "keep_retained" | "manual_value";
        sourceReceiptId?: string;
        manualValue?: string | number | null;
      }>;
      correctionReason?: string;
    };

    if (!body.retainedReceiptId || typeof body.retainedExpectedUpdatedAt !== "string" || !Array.isArray(body.sources) || !Array.isArray(body.resolutionPlan)) {
      return NextResponse.json(
        { error: "retainedReceiptId, retainedExpectedUpdatedAt, sources[], and resolutionPlan[] are required." },
        { status: 400 },
      );
    }

    const result = await applyDuplicateMerge({
      db: getReceiptsDb(),
      retainedReceiptId: body.retainedReceiptId,
      retainedExpectedUpdatedAt: body.retainedExpectedUpdatedAt,
      sources: body.sources,
      resolutionPlan: body.resolutionPlan,
      actor,
      correctionReason: body.correctionReason,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof MergeError) {
      return NextResponse.json(
        { error: error.message, code: error.code, month: error.month },
        { status: error.status },
      );
    }
    console.error("[api/receipts/duplicates/merge] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Merge failed." },
      { status: 500 },
    );
  }
}
