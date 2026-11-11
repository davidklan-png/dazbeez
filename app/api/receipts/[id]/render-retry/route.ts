import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { admitRenderRetry } from "@/lib/receipts/render-recovery";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/receipts/[id]/render-retry
 *
 * Deliberate operator recovery for a terminal render failure (backlog #22):
 * clears the failure marker so the Mac render leg picks the receipt up again
 * on its next cycle. This is the ONLY recovery for a render-failed receipt —
 * pull_render_pending excludes extraction_state='failed' rows, so they stay
 * terminal until someone explicitly asks to retry.
 *
 * NOT a general reprocess button. A strict 409 guard (admitRenderRetry)
 * admits ONLY the terminal render-failure state (needs_render=1 AND
 * extraction_state='failed' AND status captured/needs_review). Anything else
 * — legacy stalled rows (they already retry every cycle), already-recovered
 * rows, or a receipt a human advanced past review (incl. sealed/finalized
 * months, whose rows are always past needs_review) — is rejected with the
 * actual state named. It does not enqueue (render rows enqueue via /render
 * only, after the derivative lands — the intentionally narrow /enqueue
 * contract is untouched) and writes no business fields.
 *
 * Clerk-only (no processor-key path): the consumer never calls this; it is
 * the dashboard health row's "Retry render" button. It stays under
 * auth.protect() — deliberately NOT in middleware PUBLIC_ROUTES, asserted in
 * tests/middleware-routing.test.ts.
 */
export async function POST(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const { id } = await params;
    const receipt = await getReceiptRecord(id);
    if (!receipt || receipt.deleted_at) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    const admission = admitRenderRetry(receipt);
    if (!admission.ok) {
      return NextResponse.json({ error: admission.error }, { status: admission.status });
    }

    const db = getReceiptsDb();
    const now = nowIso();
    // Conditional WHERE re-checks the admitted state so a concurrent request
    // cannot double-apply or act on a row that changed under us.
    // extraction_processed_at is reset to NULL so the row matches the
    // render-pending shape (it was set by the terminal reconcile).
    await db
      .prepare(
        `UPDATE receipt_records
           SET extraction_state = 'captured',
               extraction_processed_at = NULL,
               updated_at = ?
         WHERE id = ?
           AND needs_render = 1
           AND extraction_state = 'failed'
           AND status IN ('captured', 'needs_review')`,
      )
      .bind(now, id)
      .run();

    await createAuditEntry(db, {
      actor,
      action: "receipt.render_retry",
      objectType: "receipt",
      objectId: id,
      newValueJson: stringifyJson({
        previousState: "failed",
        via: "dashboard_health_row",
      }),
    });

    return NextResponse.json(
      {
        ok: true,
        receiptId: id,
        extractionState: "captured",
        note: "Render leg will retry this receipt on its next cycle.",
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]/render-retry] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Render retry failed." },
      { status: 500 },
    );
  }
}
