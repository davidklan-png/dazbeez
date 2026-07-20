import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { promoteIntake } from "@/lib/receipts/email-intake";

// POST /api/receipts/inbox/[id]/promote
// Promote a triaged email_receipt_intake row into a real receipt via the
// canonical createReceiptRecord path (ADR 0011). Clerk-gated like every other
// /api/receipts/* route. Returns the new receipt id; the receipt then flows
// through the normal extraction queue → Mac MLX → review pipeline.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;
    const receiptId = await promoteIntake(id, actor);
    return NextResponse.json({ receiptId }, { status: 200 });
  } catch (error) {
    if (isUnauthorized(error)) return unauthorized();
    if (isNotFound(error)) return notFound();
    if (isIntakeStateConflict(error)) return conflict(error);
    console.error("[api/receipts/inbox/promote] failed", error);
    return NextResponse.json(
      { error: errorMessage(error) },
      { status: 500 },
    );
  }
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unauthorized");
}
function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}
function isIntakeStateConflict(error: unknown): boolean {
  // assertPromotable / rejectIntake refuse with messages mentioning the
  // intake's state (already promoted/rejected, nothing promotable,
  // missing R2 object). These are 409s, not 500s.
  return (
    error instanceof Error &&
    (/already (promoted|rejected|pending_triage)/i.test(error.message) ||
      /nothing promotable|no promotable attachment|no body to promote/i.test(error.message) ||
      /only pending_triage may be/i.test(error.message) ||
      /is missing from r2/i.test(error.message))
  );
}
function unauthorized() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}
function notFound() {
  return NextResponse.json({ error: "Intake row not found." }, { status: 404 });
}
function conflict(error: unknown) {
  return NextResponse.json(
    { error: errorMessage(error) },
    { status: 409 },
  );
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to promote intake.";
}
