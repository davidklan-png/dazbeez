import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { promoteIntake } from "@/lib/receipts/email-intake";
import { getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";

const PROCESSOR_ACTOR = "mlx-consumer@mac";

// Constant-time processor-key compare (mirrors /proof, /file, /extract).
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let mismatch = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

// POST /api/receipts/inbox/[id]/promote
// Promote a triaged email_receipt_intake row into a real receipt via the
// canonical createReceiptRecord path (ADR 0011). Two callers: the Mac consumer
// auto-promotes allowlisted body-only intakes with the x-receipts-processor-key
// header (ADR 0011 Phase B, option b); a human uses the inbox Promote button via
// Clerk. Layered auth mirrors /proof, /file, /extract. The receipt then flows
// through the normal extraction queue → Mac MLX → review pipeline.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const processorKey = getReceiptsProcessorKey();
    const presentedKey = request.headers.get("x-receipts-processor-key");
    const isProcessor =
      !!processorKey && !!presentedKey && timingSafeEqual(presentedKey, processorKey);
    const actor = isProcessor
      ? PROCESSOR_ACTOR
      : await requireReceiptsActor(request.headers);
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
