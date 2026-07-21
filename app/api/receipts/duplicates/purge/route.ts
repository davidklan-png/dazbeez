import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getReceiptsDb,
  getReceiptsBucket,
  getReceiptsArchiveBucket,
} from "@/lib/cloudflare-runtime";
import { purgeDuplicate, PURGE_TARGET_CAP, PurgeEligibilityError } from "@/lib/receipts/duplicate-purge";

// POST /api/receipts/duplicates/purge
// Operator-confirmed permanent duplicate purge (correction §2 contract). Server
// revalidates everything; one request-wide atomic D1 batch (trigger-guarded);
// R2 cleanup loud + retryable. The ONLY path that performs permanent purge.
//
// Strength is NOT sent by the client — the server derives it per retained/target
// pair (mixed strong/near clusters store the correct strength per target).
export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json()) as {
      retainedReceiptId?: string;
      retainedExpectedUpdatedAt?: string;
      targets?: Array<{ receiptId: string; expectedUpdatedAt: string }>;
      visualConfirmed?: boolean;
      legalHoldExceptionAcknowledged?: boolean;
      confirmationText?: string;
      reason?: string;
    };

    if (!body.retainedReceiptId || typeof body.retainedExpectedUpdatedAt !== "string" || !Array.isArray(body.targets)) {
      return NextResponse.json(
        { error: "retainedReceiptId, retainedExpectedUpdatedAt, and targets[] are required." },
        { status: 400 },
      );
    }
    // Light shape check before handing to the authoritative validator.
    if (body.targets.length > PURGE_TARGET_CAP) {
      return NextResponse.json(
        { error: `Too many targets; cap is ${PURGE_TARGET_CAP}.` },
        { status: 400 },
      );
    }
    for (const t of body.targets) {
      if (typeof t.receiptId !== "string" || typeof t.expectedUpdatedAt !== "string") {
        return NextResponse.json({ error: "Each target needs { receiptId, expectedUpdatedAt }." }, { status: 400 });
      }
    }

    const result = await purgeDuplicate({
      db: getReceiptsDb(),
      receiptsBucket: getReceiptsBucket(),
      archiveBucket: getReceiptsArchiveBucket(),
      retainedReceiptId: body.retainedReceiptId,
      retainedExpectedUpdatedAt: body.retainedExpectedUpdatedAt,
      targets: body.targets,
      visualConfirmed: !!body.visualConfirmed,
      legalHoldExceptionAcknowledged: !!body.legalHoldExceptionAcknowledged,
      confirmationText: body.confirmationText ?? "",
      reason: body.reason ?? "",
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
