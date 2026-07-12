import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { updateAmexLineCategory } from "@/lib/receipts/db";
import { parseAmexLinePatch, type AmexLinePatchBody } from "@/lib/receipts/api/amex-line-patch";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;
    const body = (await request.json()) as AmexLinePatchBody;

    // Parse+validate lives in a pure helper (lib/receipts/api/amex-line-patch)
    // so the sparse-update contract the DB layer relies on is unit-tested
    // without D1 — guards the #67 regression (always-present key NULLing
    // sibling columns).
    const parsed = parseAmexLinePatch(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    await updateAmexLineCategory(id, parsed.input, actor);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
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
