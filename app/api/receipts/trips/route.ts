import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  listBusinessTripsWithCounts,
  createBusinessTrip,
} from "@/lib/receipts/db";
import { validateTripDates } from "@/lib/receipts/business-trips";

// Business trips (ADR 0010): list with member counts, or create an
// operator-managed trip (born 'confirmed'). Detection-created trips stay
// 'candidate' and are linked to existing overlapping trips on import (dedupe).

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const trips = await listBusinessTripsWithCounts();
    return NextResponse.json({ trips }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/trips] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load business trips." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const body = (await request.json().catch(() => ({}))) as {
      tripName?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      purpose?: unknown;
      primaryLocation?: unknown;
      cardholderName?: unknown;
    };

    const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
    const endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
    const dateCheck = validateTripDates(startDate, endDate);
    if (!dateCheck.ok) {
      return NextResponse.json({ error: dateCheck.error }, { status: 400 });
    }

    const id = await createBusinessTrip(
      {
        tripName: typeof body.tripName === "string" ? body.tripName : null,
        startDate,
        endDate,
        purpose: typeof body.purpose === "string" ? body.purpose : null,
        primaryLocation:
          typeof body.primaryLocation === "string" ? body.primaryLocation : null,
        cardholderName:
          typeof body.cardholderName === "string" ? body.cardholderName : null,
      },
      actor,
    );
    return NextResponse.json({ id }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/trips] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create trip." },
      { status: 500 },
    );
  }
}
