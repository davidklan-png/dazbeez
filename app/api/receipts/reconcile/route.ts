import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders, getReceiptsActor } from "@/lib/receipts/auth";
import { updateAmexReconciliation } from "@/lib/receipts/db";
import type { AmexMatchStatus } from "@/lib/receipts/types";

const VALID_STATUSES: AmexMatchStatus[] = [
  "unmatched",
  "matched",
  "confirmed",
  "no_receipt",
];

export async function POST(request: Request) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);

    const body = (await request.json()) as {
      amexLineId?: string;
      receiptId?: string | null;
      matchStatus?: string;
    };

    if (!body.amexLineId) {
      return NextResponse.json({ error: "amexLineId is required." }, { status: 400 });
    }

    if (!body.matchStatus || !VALID_STATUSES.includes(body.matchStatus as AmexMatchStatus)) {
      return NextResponse.json(
        { error: `matchStatus must be one of: ${VALID_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }

    await updateAmexReconciliation(
      body.amexLineId,
      body.receiptId ?? null,
      body.matchStatus as AmexMatchStatus,
      actor,
    );

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/reconcile] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reconciliation failed." },
      { status: 500 },
    );
  }
}
