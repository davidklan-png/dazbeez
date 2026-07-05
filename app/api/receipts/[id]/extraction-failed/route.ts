import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getReceiptRecord,
  reconcileExtractionState,
} from "@/lib/receipts/db";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
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

interface ExtractionFailedBody {
  /** Why extraction failed (e.g. "UnidentifiedImageError", "pymupdf: empty file"). */
  reason?: string;
  /** Optional provider/model label for provenance, e.g. "mlx_local:qwen3-vl-32b". */
  model?: string;
}

/**
 * Mark a receipt's extraction as permanently failed (ADR 0001).
 *
 * Called by the Mac MLX consumer (`scripts/receipts-consumer/consumer.py`) when
 * it classifies a local failure as deterministic-permanent — corrupt image,
 * zero-byte file, pymupdf open/render error. The consumer then ACKs the queue
 * message so it does not retry forever or land in the DLQ. Transient failures
 * (network, HTTP 5xx, model load) stay on the existing unacked-retry path.
 *
 * Auth mirrors `/extract`: processor key OR Clerk-authenticated human actor.
 * The Clerk middleware exemption (ce01989) is required so processor-key
 * requests reach the handler instead of being 404-rewritten by `auth.protect()`
 * — see middleware.ts isPublicRoute list.
 *
 * Effect: `extraction_state` moves to `'failed'` only from pending states
 * (captured/queued/processing). Locked statuses (reviewed/reconciled/exported/
 * archived) return 409 — a late failure report for a receipt a human already
 * handled must not roll the queue state back.
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
      | ExtractionFailedBody
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
        action: "receipt.extraction_failed",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({ reason: "not_found", failureReason: reason }),
      });
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    // Locked statuses: a human has already advanced this receipt. A late
    // failure report from the consumer must not un-review it. Mirror the
    // guard in /extract — including reconciling any stale pending state so
    // the month-close gate isn't blocked by a queue message that arrived
    // after human review.
    if (receipt.status !== "captured" && receipt.status !== "needs_review") {
      await reconcileExtractionState(id, "processed");
      await createAuditEntry(db, {
        actor,
        action: "receipt.extraction_failed",
        objectType: "receipt",
        objectId: id,
        newValueJson: stringifyJson({
          reason: "locked",
          status: receipt.status,
          failureReason: reason,
        }),
      });
      return NextResponse.json(
        {
          error: `Receipt is ${receipt.status} and cannot be marked as extraction-failed.`,
        },
        { status: 409 },
      );
    }

    // Persist the failure into extraction_json. This column is the canonical
    // "latest extraction outcome" surface; the review UI reads it to badge
    // the receipt. No DB migration needed (architect preference). Shape:
    //   { failed: true, reason, model?, failedAt }
    // Any prior extraction_json on a pending receipt is incomplete/stale
    // (the receipt never reached 'processed'); overwrite is the right move.
    const failedPayload = {
      failed: true as const,
      reason,
      model: body?.model?.trim() || null,
      failedAt: nowIso(),
    };

    // reconcileExtractionState is idempotent — only touches rows still in a
    // pending state. If a parallel request already advanced this receipt,
    // the UPDATE is a no-op and we surface that to the caller as 409.
    await reconcileExtractionState(id, "failed");

    // Write extraction_json separately (reconcileExtractionState does not
    // touch it). Bypasses the finalized-reconciliation guard like /extract
    // does for the same reason — this is queue-state mirror, not business
    // fields.
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
      action: "receipt.extraction_failed",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({
        failureReason: reason,
        model: body?.model?.trim() || null,
      }),
    });

    return NextResponse.json(
      { ok: true, extractionState: "failed", failedAt: failedPayload.failedAt },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]/extraction-failed] failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to mark extraction-failed.",
      },
      { status: 500 },
    );
  }
}
