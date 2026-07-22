import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { getIntake, rejectIntake } from "@/lib/receipts/email-intake";
import { blockSender } from "@/lib/receipts/sender-policy";
import { classifyBlockRejectError } from "@/lib/receipts/block-sender-result";

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
    // Only the documented already-terminal conflict (already promoted/rejected)
    // is a safe partial success; any other failure is a real error.
    try {
      await rejectIntake(db, id, "blocked_sender", actor);
    } catch (rejectErr) {
      const result = classifyBlockRejectError(rejectErr);
      if (result.kind === "partial-success") {
        return NextResponse.json(
          { ok: true, blocked: intake.from_address, rejected: false, note: result.note },
          { status: 200 },
        );
      }
      console.error("[api/receipts/inbox/block-sender] rejectIntake failed after block", {
        id, blocked: intake.from_address, error: result.message,
      });
      return NextResponse.json(
        { error: result.message, blocked: intake.from_address, rejected: false },
        { status: 500 },
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
