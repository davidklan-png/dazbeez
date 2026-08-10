import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import { getExport, updateExportOperatorMessage } from "@/lib/receipts/db";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ month: string }> };

/** Max operator-message length in characters (E1). Enforced server-side; the
 *  UI mirrors the same cap on its character counter. */
const MAX_OPERATOR_MESSAGE_LENGTH = 2000;

/**
 * PATCH /api/receipts/export/[month]/message — the ONE storage path the GUI
 * writes for the editable preface (【今月のご連絡】). Pre-E1 nothing wrote
 * operator_message from the UI, and a rebuild that omitted it from the body
 * nulled the stored column (fixed separately in the rebuild route).
 *
 * - 400 when the trimmed message exceeds 2000 characters.
 * - Trim on write; empty/whitespace stores NULL (buildPackNotice then omits the
 *   whole 【今月のご連絡】 heading — preserved).
 * - 409 when the month has no open draft (finalized with no open revision): the
 *   sealed bundle is immutable; create a revision first. This reuses the same
 *   draft/sealed predicate the download route uses (getExport → status==='draft').
 * - Line endings are stored as-is; buildPackNotice normalizes to CRLF at render.
 *
 * Touches ONLY operator_message (updateExportOperatorMessage) — it deliberately
 * does not advance bundle_built_at, so editing a built draft leaves it stale and
 * the finalize gate (E3, message_stale) requires a rebuild before sealing.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { month } = await params;

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Invalid month format." }, { status: 400 });
    }

    let body: { message?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const trimmed = (typeof body.message === "string" ? body.message : "").trim();
    if (trimmed.length > MAX_OPERATOR_MESSAGE_LENGTH) {
      return NextResponse.json(
        {
          error: `Message is too long (max ${MAX_OPERATOR_MESSAGE_LENGTH} characters).`,
        },
        { status: 400 },
      );
    }

    // Reuse the existing draft/sealed predicate: getExport returns the current
    // row, which is a draft iff one is open. Sealed (or no row) → 409.
    const current = await getExport(month);
    if (!current || current.status !== "draft") {
      return NextResponse.json(
        { error: `${month} is sealed. Create a revision to change the message.` },
        { status: 409 },
      );
    }

    const stored = trimmed.length > 0 ? trimmed : null;
    await updateExportOperatorMessage(current.id, stored);

    await createAuditEntry(getReceiptsDb(), {
      actor,
      action: "export.message_updated",
      objectType: "export",
      objectId: current.id,
      newValueJson: stringifyJson({ month, operatorMessage: stored }),
    });

    return NextResponse.json({ operatorMessage: stored });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/export/[month]/message] PATCH failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save message." },
      { status: 500 },
    );
  }
}
