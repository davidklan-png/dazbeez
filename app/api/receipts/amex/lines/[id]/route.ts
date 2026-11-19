import { AmexWriteError, revisionInputError } from "@/lib/receipts/amex-write";
import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { isSealBoundaryConflict } from "@/lib/receipts/month-lock";
import { updateAmexLineCategory } from "@/lib/receipts/db";
import { parseAmexLinePatch, type AmexLinePatchBody } from "@/lib/receipts/api/amex-line-patch";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as AmexLinePatchBody;

    const revisionError = revisionInputError(body?.expectedRevision);
    if (revisionError) return NextResponse.json(revisionError, { status: 400 });

    // Parse+validate lives in a pure helper (lib/receipts/api/amex-line-patch)
    // so the sparse-update contract the DB layer relies on is unit-tested
    // without D1 — guards the #67 regression (always-present key NULLing
    // sibling columns).
    const parsed = parseAmexLinePatch(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const result = await updateAmexLineCategory(id, parsed.input, actor, body.expectedRevision as number);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof AmexWriteError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (isSealBoundaryConflict(error)) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Conflicts with an active build or a sealed month." },
        { status: 409 },
      );
    }
    // 409: month's reconciliation is finalized — edits blocked
    if (error instanceof Error && error.message.includes("is finalized")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[api/receipts/amex/lines/[id]] PATCH failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Update failed." },
      { status: 500 },
    );
  }
}
