import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { retryRender } from "@/lib/receipts/render-recovery";
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
 * NOT a general reprocess button. retryRender (lib/receipts/render-recovery.ts)
 * enforces the admission INSIDE one atomic conditional UPDATE — needs_render=1,
 * extraction_state='failed', pre-review status, deleted_at IS NULL, and the
 * canonical month/seal guards from month-lock.ts (finalized export with no
 * open draft in the transaction month; AMEX match in an edit-locked finalized
 * reconciliation) — then inspects affected rows. Zero rows changed is
 * re-read and answered honestly (deleted → 404; raced review/seal/recovery →
 * 409 naming the actual state), never a false success. It does not enqueue
 * (render rows enqueue via /render only, after the derivative lands — the
 * intentionally narrow /enqueue contract is untouched) and writes no
 * business fields.
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
    const result = await retryRender({
      db: getReceiptsDb(),
      receiptId: id,
      actor,
    });

    switch (result.kind) {
      case "retrying":
        return NextResponse.json(
          {
            ok: true,
            receiptId: id,
            extractionState: "captured",
            note: "Render leg will retry this receipt on its next cycle.",
          },
          { status: 200 },
        );
      case "not_found":
        return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
      case "conflict":
        return NextResponse.json({ error: result.error }, { status: 409 });
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    // B5: never echo internals (D1/SQL error text) to the client — log only.
    console.error("[api/receipts/[id]/render-retry] POST failed", error);
    return NextResponse.json(
      { error: "Render retry failed. The receipt was not modified." },
      { status: 500 },
    );
  }
}
