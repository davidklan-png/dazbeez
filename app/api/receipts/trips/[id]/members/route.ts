import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  attachTripMembers,
  detachTripMembers,
  findCrossTripLineConflicts,
} from "@/lib/receipts/db";

type RouteContext = { params: Promise<{ id: string }> };

// Trip membership (ADR 0010 D2): attach/detach lines + receipts.
//   - Lines get business_trip_id + status; a link-table row. A line already on
//     a DIFFERENT trip → 409 (detach there first; no silent moves).
//   - Receipts get a link-table row ONLY — receipt rows are NEVER written, so
//     sealed-month receipts are legal members by construction.

function parseMemberIds(body: unknown): {
  lineIds: string[];
  receiptIds: string[];
  malformed: boolean;
} {
  if (typeof body !== "object" || body === null) {
    return { lineIds: [], receiptIds: [], malformed: true };
  }
  const { lineIds, receiptIds } = body as { lineIds?: unknown; receiptIds?: unknown };
  const ok = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if (lineIds !== undefined && !ok(lineIds)) {
    return { lineIds: [], receiptIds: [], malformed: true };
  }
  if (receiptIds !== undefined && !ok(receiptIds)) {
    return { lineIds: [], receiptIds: [], malformed: true };
  }
  return {
    lineIds: (lineIds as string[] | undefined) ?? [],
    receiptIds: (receiptIds as string[] | undefined) ?? [],
    malformed: false,
  };
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;
    const parsed = parseMemberIds(await request.json().catch(() => null));
    if (parsed.malformed) {
      return NextResponse.json(
        { error: "Body must be { lineIds?: string[], receiptIds?: string[] }." },
        { status: 400 },
      );
    }
    if (parsed.lineIds.length === 0 && parsed.receiptIds.length === 0) {
      return NextResponse.json(
        { error: "Provide lineIds and/or receiptIds to attach." },
        { status: 400 },
      );
    }

    // Cross-trip line conflict → 409 (operator detaches at the owner first).
    const conflicts = await findCrossTripLineConflicts(id, parsed.lineIds);
    if (conflicts.length > 0) {
      return NextResponse.json(
        {
          error: "Some lines already belong to another trip. Detach them there first.",
          conflicts,
        },
        { status: 409 },
      );
    }

    const result = await attachTripMembers(id, parsed, actor);
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const msg = error instanceof Error ? error.message : "";
    if (msg.includes("not found")) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }
    console.error("[api/receipts/trips/[id]/members] POST failed", error);
    return NextResponse.json(
      { error: msg || "Failed to attach members." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;
    const parsed = parseMemberIds(await request.json().catch(() => null));
    if (parsed.malformed) {
      return NextResponse.json(
        { error: "Body must be { lineIds?: string[], receiptIds?: string[] }." },
        { status: 400 },
      );
    }
    if (parsed.lineIds.length === 0 && parsed.receiptIds.length === 0) {
      return NextResponse.json(
        { error: "Provide lineIds and/or receiptIds to detach." },
        { status: 400 },
      );
    }

    const result = await detachTripMembers(id, parsed, actor);
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/trips/[id]/members] DELETE failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to detach members." },
      { status: 500 },
    );
  }
}
