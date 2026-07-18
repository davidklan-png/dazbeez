import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getBusinessTripWithMembers,
  listTripAttachCandidates,
} from "@/lib/receipts/db";
import { candidateWindow, filterAttachCandidates, dedupeChargeCandidates } from "@/lib/receipts/business-trips";

type RouteContext = { params: Promise<{ id: string }> };

// Trip attach-candidate picker (ADR 0010 D2). Returns charges attachable to
// the trip: AMEX lines + receipts whose transaction_date falls within
// [trip.start − window, trip.end + window] (cross-month by construction),
// EXCLUDING current members of this trip. Lines owned by a different trip are
// included but flagged (ownedByTripId) so the UI can show why attach will 409.
// ?all=true drops the date window (the "show all" escape).

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireReceiptsActor(request.headers);
    const { id } = await params;
    const url = new URL(request.url);
    const windowDays = Math.max(
      0,
      Math.min(365, Number.parseInt(url.searchParams.get("window") ?? "45", 10) || 45),
    );
    const all = url.searchParams.get("all") === "true";
    const q = url.searchParams.get("q") ?? "";

    // Trip row + current members in one call. 404 if the trip doesn't exist.
    const detail = await getBusinessTripWithMembers(id);
    if (!detail.trip) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }

    const window =
      all || !detail.trip.start_date || !detail.trip.end_date
        ? null
        : candidateWindow(
            { startDate: detail.trip.start_date, endDate: detail.trip.end_date },
            windowDays,
          );

    const memberLineIds = new Set(detail.lines.map((l) => l.id));
    const memberReceiptIds = new Set(detail.receipts.map((r) => r.id));

    // db narrows by window + q (SQL); pure helpers exclude current members and
    // dedupe (a receipt matched to a line is the same charge — fold it into the
    // line row, never a separate candidate).
    const rows = await listTripAttachCandidates({ window, q });
    const candidates = dedupeChargeCandidates(
      filterAttachCandidates(rows, {
        memberLineIds,
        memberReceiptIds,
        window,
        q,
      }),
    );

    return NextResponse.json(
      { candidates, window, tripId: id },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/trips/[id]/candidates] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load trip candidates." },
      { status: 500 },
    );
  }
}
