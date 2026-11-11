import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord, reconcileExtractionState } from "@/lib/receipts/db";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { admitRenderFailure } from "@/lib/receipts/render-recovery";
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

interface RenderFailedBody {
  /** Why the render failed permanently (e.g. "WeasyPrint produced an empty
   * PDF"). Classifier-generated — never the raw email body. */
  reason?: string;
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
 * Effect: `extraction_state` → 'failed' (only from pending states via
 * reconcileExtractionState — idempotent) and extraction_json gains the
 * failure payload with `stage: 'render'` so the pipeline-health surface can
 * distinguish a terminal RENDER failure (needs_render=1) from a terminal
 * EXTRACTION failure. needs_render stays 1 — the row keeps its evidence and
 * remains the class discriminator. The original body in R2 is untouched.
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
    const body = (await request.json().catch(() => null)) as
      | RenderFailedBody
      | null;
    const reason = (body?.reason ?? "").trim();
    if (!reason) {
      return NextResponse.json(
        { error: "Body must include a non-empty `reason`." },
        { status: 400 },
      );
    }
    if (reason.length > 1000) {
      return NextResponse.json(
        { error: "`reason` must be 1000 characters or fewer." },
        { status: 413 },
      );
    }

    const receipt = await getReceiptRecord(id);
    const db = getReceiptsDb();

    if (!receipt) {
      await createAuditEntry(db, {
        actor,
        action: "receipt.render_failed",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({ reason: "not_found", failureReason: reason }),
      });
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    // Rejections: 409 + audit. Only the human-advanced case also reconciles a
    // stale pending state (mirrors /extraction-failed — the month-close gate
    // must not stay blocked by a queue report that arrived after human
    // review). A needs_render=0 rejection is a wrong-pipeline report and must
    // NOT touch extraction_state — the row may legitimately be mid-extraction.
    const admission = admitRenderFailure(receipt);
    if (!admission.ok) {
      const humanAdvanced =
        receipt.status !== "captured" && receipt.status !== "needs_review";
      if (
        humanAdvanced &&
        receipt.extraction_state &&
        ["captured", "queued", "processing"].includes(receipt.extraction_state)
      ) {
        await reconcileExtractionState(id, "processed");
      }
      await createAuditEntry(db, {
        actor,
        action: "receipt.render_failed",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({
          reason: "rejected",
          status: receipt.status,
          failureReason: reason,
        }),
      });
      return NextResponse.json({ error: admission.error }, { status: admission.status });
    }

    const failedPayload = {
      failed: true as const,
      stage: "render" as const,
      reason,
      failedAt: nowIso(),
    };

    // Idempotent: only transitions rows still in a pending state.
    await reconcileExtractionState(id, "failed");

    // Write extraction_json separately, gated on the terminal state (mirrors
    // /extraction-failed). Bypasses the finalized-reconciliation guard for the
    // same reason — queue-state mirror, not business fields.
    await db
      .prepare(
        `UPDATE receipt_records
           SET extraction_json = ?, updated_at = ?
         WHERE id = ?
           AND extraction_state = 'failed'`,
      )
      .bind(stringifyJson(failedPayload), nowIso(), id)
      .run();

    await createAuditEntry(db, {
      actor,
      action: "receipt.render_failed",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({ failureReason: reason, stage: "render" }),
    });

    return NextResponse.json(
      { ok: true, extractionState: "failed", failedAt: failedPayload.failedAt },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]/render-failed] failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to mark render-failed.",
      },
      { status: 500 },
    );
  }
}
