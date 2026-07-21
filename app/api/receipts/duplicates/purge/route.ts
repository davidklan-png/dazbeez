import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getReceiptsDb,
  getReceiptsBucket,
  getReceiptsArchiveBucket,
} from "@/lib/cloudflare-runtime";
import { purgeDuplicate, PurgeEligibilityError } from "@/lib/receipts/duplicate-purge";

// POST /api/receipts/duplicates/purge
// Operator-confirmed permanent duplicate purge. Server revalidates everything
// (never trusts client scores). D1 reference cleanup + receipt deletion are one
// atomic batch; R2 cleanup is loud + retryable. This is the ONLY path that
// performs permanent purge — the ordinary soft-delete is separate.
export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json()) as {
      retainedReceiptId?: string;
      purgeReceiptIds?: string[];
      expectedUpdatedAt?: Record<string, string>;
      visualConfirmed?: boolean;
      confirmationText?: string;
      reason?: string;
      strength?: "strong" | "near";
    };

    if (!body.retainedReceiptId || !Array.isArray(body.purgeReceiptIds)) {
      return NextResponse.json({ error: "retainedReceiptId and purgeReceiptIds are required." }, { status: 400 });
    }

    const result = await purgeDuplicate({
      db: getReceiptsDb(),
      receiptsBucket: getReceiptsBucket(),
      archiveBucket: getReceiptsArchiveBucket(),
      retainedReceiptId: body.retainedReceiptId,
      purgeReceiptIds: body.purgeReceiptIds,
      expectedUpdatedAt: body.expectedUpdatedAt ?? {},
      visualConfirmed: !!body.visualConfirmed,
      confirmationText: body.confirmationText ?? "",
      reason: body.reason ?? "",
      strength: body.strength === "near" ? "near" : "strong",
      actor,
    });

    // 200 even on partial storage cleanup — the response carries storage_failed
    // targets so the UI can surface a persistent retryable warning.
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof PurgeEligibilityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/receipts/duplicates/purge] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Purge failed." },
      { status: 500 },
    );
  }
}
