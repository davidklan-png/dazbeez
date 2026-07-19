import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { rejectIntake } from "@/lib/receipts/email-intake";

// POST /api/receipts/inbox/[id]/reject  body: { reason: string }
// Reject a pending intake row with a REQUIRED reason. Does not create a
// receipt and does not delete the R2 object immediately (30-day cleanup does).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;

    let reason = "";
    try {
      const body = (await request.json()) as { reason?: unknown };
      reason = typeof body.reason === "string" ? body.reason : "";
    } catch {
      // Empty/non-JSON body → empty reason → rejectIntake throws below.
      reason = "";
    }

    await rejectIntake(getReceiptsDb(), id, reason, actor);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof Error && /reject_reason is required/i.test(error.message)) {
      return NextResponse.json(
        { error: "A reject reason is required." },
        { status: 400 },
      );
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      return NextResponse.json({ error: "Intake row not found." }, { status: 404 });
    }
    if (
      error instanceof Error &&
      (/already (promoted|rejected)/i.test(error.message) ||
        /only pending_triage may be/i.test(error.message))
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: 409 },
      );
    }
    console.error("[api/receipts/inbox/reject] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reject intake." },
      { status: 500 },
    );
  }
}
