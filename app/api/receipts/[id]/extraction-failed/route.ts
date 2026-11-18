import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { parseExtractionFailedBody, recordExtractionFailure } from "@/lib/receipts/extraction-failure";
import { getReceiptsDb, getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

const PROCESSOR_ACTOR = "mlx-consumer@mac";

// Constant-time string compare so the processor key can't be probed by timing.
// Mirrors the helper in /api/receipts/[id]/extract/route.ts — kept local so a
// future change to either route doesn't silently regress the other.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let mismatch = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

/** Processor-key OR Clerk auth; the middleware exemption must remain in place. */
export async function POST(request: Request, { params }: RouteContext) {
  try {
    // Layered auth: processor key first, then Clerk human-actor fall-through.
    const processorKey = getReceiptsProcessorKey();
    const presentedKey = request.headers.get("x-receipts-processor-key");
    const isProcessor =
      !!processorKey &&
      !!presentedKey &&
      timingSafeEqual(presentedKey, processorKey);
    const actor = isProcessor
      ? PROCESSOR_ACTOR
      : await requireReceiptsActor(request.headers);

    const { id } = await params;
    const parsed = parseExtractionFailedBody(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    }
    const result = await recordExtractionFailure({
      db: getReceiptsDb(), receiptId: id, actor,
      reason: parsed.reason, model: parsed.model,
    });
    switch (result.kind) {
      case "recorded":
        return NextResponse.json({ ok: true, extractionState: "failed", failedAt: result.failedAt });
      case "already_terminal":
        return NextResponse.json({
          ok: true, extractionState: "failed", alreadyRecorded: true,
          reason: result.reason, failedAt: result.failedAt,
        });
      case "processed":
        return NextResponse.json({ ok: true, extractionState: "processed", alreadyHandled: true });
      case "not_found":
        return NextResponse.json({ outcome: "not_found", error: "Receipt not found." }, { status: 404 });
      case "refused":
        return NextResponse.json({
          outcome: "refused",
          error: "Receipt is not admitted for extraction failure. Refresh the dashboard to check its current state.",
        }, { status: 409 });
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]/extraction-failed] failed", error);
    return NextResponse.json(
      {
        error: "Extraction failure report unconfirmed — refresh the dashboard to check this receipt's current state.",
      },
      { status: 500 },
    );
  }
}
