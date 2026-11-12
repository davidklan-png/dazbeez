import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import { parseRenderFailedBody, recordRenderFailure } from "@/lib/receipts/render-recovery";
import { getReceiptsDb, getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

const PROCESSOR_ACTOR = "mlx-consumer@mac";

// Constant-time string compare so the processor key can't be probed by timing.
// Mirrors the helper in /extraction-failed — kept local so a future change to
// either route doesn't silently regress the other.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let mismatch = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

/**
 * Mark a needs_render receipt's render as permanently failed (backlog #22).
 *
 * Called by the Mac consumer's render leg (`process_renders`) when it
 * classifies a render failure as deterministic-permanent — empty body bytes
 * in R2, renderer producing an empty PDF. The consumer's pull query then
 * excludes the row, so it stops retrying every cycle. Transient failures
 * (network, WeasyPrint environmental errors, HTTP failures) never reach this
 * endpoint — they stay on the retry path.
 *
 * Auth mirrors /extraction-failed: processor key OR Clerk human actor, and
 * the Clerk middleware exemption (PUBLIC_ROUTES in middleware.ts) is required
 * so processor-key requests reach the handler instead of being 404-rewritten
 * by `auth.protect()` — asserted in tests/middleware-routing.test.ts.
 *
 * Persistence lives in recordRenderFailure (lib/receipts/render-recovery.ts):
 * ONE atomic conditional UPDATE commits extraction_state='failed' together
 * with a merged extraction_json payload that preserves existing extraction
 * data (review B1/B2); the first committed terminal marker is immutable and
 * a repeat report is a read-only idempotent success. The body is validated
 * for runtime types before any string logic (review B4) — malformed JSON
 * values get 4xx, never 500.
 */
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
    const raw = await request.json().catch(() => null);
    const parsed = parseRenderFailedBody(raw);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    }

    const result = await recordRenderFailure({
      db: getReceiptsDb(),
      receiptId: id,
      reason: parsed.reason,
      actor,
    });

    switch (result.kind) {
      case "recorded":
        return NextResponse.json(
          { ok: true, extractionState: "failed", failedAt: result.failedAt },
          { status: 200 },
        );
      case "already_terminal":
        // Idempotent: the FIRST committed marker is authoritative. The
        // response names it so the consumer's log cannot claim a fresh mark.
        return NextResponse.json(
          {
            ok: true,
            extractionState: "failed",
            alreadyRecorded: true,
            reason: result.reason,
            failedAt: result.failedAt,
          },
          { status: 200 },
        );
      case "not_found":
        await createAuditEntry(getReceiptsDb(), {
          actor,
          action: "receipt.render_failed",
          objectType: "receipt",
          objectId: id,
          newValueJson: stringifyJson({
            reason: "not_found",
            failureReason: parsed.reason,
          }),
        });
        return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
      case "conflict":
        return NextResponse.json({ error: result.error }, { status: 409 });
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    // B5: never echo internals (D1/SQL error text) to the client — log only.
    console.error("[api/receipts/[id]/render-failed] failed", error);
    return NextResponse.json(
      { error: "Failed to mark render-failed — refresh the dashboard to check this receipt's current state." },
      { status: 500 },
    );
  }
}
