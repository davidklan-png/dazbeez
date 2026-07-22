import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { getIntake, rejectIntake } from "@/lib/receipts/email-intake";
import { blockSender } from "@/lib/receipts/sender-policy";

// POST /api/receipts/inbox/[id]/block-sender
// Combined action (ADR 0011 follow-up decision 11): blocks the sender (removes
// any trusted row + adds a blocked row) AND rejects THIS ONE intake row with
// reason "blocked_sender". Does NOT mass-reject other pending rows from the
// same sender. Clerk-gated (human action only, never processor-key).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;
    const db = getReceiptsDb();

    const intake = await getIntake(db, id);
    if (!intake) {
      return NextResponse.json(
        { error: "Intake row not found." },
        { status: 404 },
      );
    }

    // Block the sender (mutual-exclusion transition: removes trusted if present).
    await blockSender(db, intake.from_address, actor);

    // Reject ONLY this row (not other pending rows from the same sender).
    // rejectIntake throws if the row is already promoted/rejected — surface as
    // a 409 so the UI can handle it gracefully.
    try {
      await rejectIntake(db, id, "blocked_sender", actor);
    } catch {
      // Row was already promoted/rejected — sender is still blocked; surface
      // the partial result so the UI knows the block succeeded.
      return NextResponse.json(
        {
          ok: true,
          blocked: intake.from_address,
          rejected: false,
          note: "Sender blocked; row was already terminal and could not be rejected.",
        },
        { status: 200 },
      );
    }

    return NextResponse.json(
      { ok: true, blocked: intake.from_address, rejected: true },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/inbox/block-sender] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to block sender." },
      { status: 500 },
    );
  }
}
