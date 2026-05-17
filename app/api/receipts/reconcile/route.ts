import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
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
    const actor = await requireReceiptsActor(request.headers);

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

    const status = body.matchStatus as AmexMatchStatus;
    if ((status === "confirmed" || status === "matched") && !body.receiptId) {
      return NextResponse.json(
        { error: "receiptId is required for confirmed/matched" },
        { status: 400 },
      );
    }
    if ((status === "unmatched" || status === "no_receipt") && body.receiptId) {
      return NextResponse.json(
        { error: "receiptId must be null for unmatched/no_receipt" },
        { status: 400 },
      );
    }

    await updateAmexReconciliation(
      body.amexLineId,
      body.receiptId ?? null,
      status,
      actor,
    );

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    // 409: receipt already confirmed against a different AMEX line (race guard in db.ts)
    if (error instanceof Error && error.message.startsWith("Receipt already confirmed against another AMEX line")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // 409: month's reconciliation is finalized — edits blocked
    if (error instanceof Error && error.message.includes("is finalized")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[api/receipts/reconcile] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reconciliation failed." },
      { status: 500 },
    );
  }
}
