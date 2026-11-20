import { AmexWriteError, tripExpectation } from "@/lib/receipts/amex-write";
import { isSealBoundaryConflict } from "@/lib/receipts/month-lock";
import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getBusinessTripWithMembers,
  updateBusinessTrip,
} from "@/lib/receipts/db";
import { validateTripDates } from "@/lib/receipts/business-trips";
import type { BusinessTripStatus } from "@/lib/receipts/types";

type RouteContext = { params: Promise<{ id: string }> };

// Business trip detail + edit (ADR 0010): GET resolves member lines + receipts;
// PATCH edits fields and/or transitions status (candidate → confirmed |
// rejected). 'exported' is terminal (Phase C) → 409.

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireReceiptsActor(request.headers);
    const { id } = await params;
    const detail = await getBusinessTripWithMembers(id);
    if (!detail.trip) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }
    return NextResponse.json(detail, { status: 200 });
  } catch (error) {
    if (error instanceof AmexWriteError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (isSealBoundaryConflict(error)) return NextResponse.json({ error: "Conflicts with an active build or sealed month.", code: "seal_conflict" }, { status: 409 });
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/trips/[id]] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load trip." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      expectedRevision?: unknown;
      expectedLines?: unknown;
      tripName?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      purpose?: unknown;
      primaryLocation?: unknown;
      status?: unknown;
    };

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "Body must be an object.", code: "expected_revision_required" }, { status: 400 });
    }
    const admission = tripExpectation(body, body.status !== undefined);
    if (admission.error) return NextResponse.json(admission.error, { status: 400 });
    // Date edits require BOTH dates so start<=end is checkable.
    const hasStartDate = "startDate" in body;
    const hasEndDate = "endDate" in body;
    if (hasStartDate || hasEndDate) {
      if (!hasStartDate || !hasEndDate) {
        return NextResponse.json(
          { error: "Provide both startDate and endDate to edit trip dates." },
          { status: 400 },
        );
      }
      const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
      const endDate = typeof body.endDate === "string" ? body.endDate.trim() : "";
      const dateCheck = validateTripDates(startDate, endDate);
      if (!dateCheck.ok) {
        return NextResponse.json({ error: dateCheck.error }, { status: 400 });
      }
    }

    // Status value pre-check (format); the exported/transition guard runs in
    // updateBusinessTrip and is surfaced as a 409 below.
    let status: BusinessTripStatus | undefined;
    if (body.status !== undefined) {
      if (
        typeof body.status !== "string" ||
        (body.status !== "confirmed" && body.status !== "rejected")
      ) {
        return NextResponse.json(
          { error: "status must be 'confirmed' or 'rejected'." },
          { status: 400 },
        );
      }
      status = body.status as BusinessTripStatus;
    }

    const result = await updateBusinessTrip(
      id,
      {
        tripName:
          typeof body.tripName === "string"
            ? body.tripName
            : body.tripName === null
              ? null
              : undefined,
        startDate:
          typeof body.startDate === "string" ? body.startDate.trim() : undefined,
        endDate:
          typeof body.endDate === "string" ? body.endDate.trim() : undefined,
        purpose:
          typeof body.purpose === "string"
            ? body.purpose
            : body.purpose === null
              ? null
              : undefined,
        primaryLocation:
          typeof body.primaryLocation === "string"
            ? body.primaryLocation
            : body.primaryLocation === null
              ? null
              : undefined,
        status,
      },
      actor,
      admission.expected,
    );

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof AmexWriteError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (isSealBoundaryConflict(error)) return NextResponse.json({ error: "Conflicts with an active build or sealed month.", code: "seal_conflict" }, { status: 409 });
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const msg = error instanceof Error ? error.message : "";
    if (msg.includes("not found")) {
      return NextResponse.json({ error: "Trip not found." }, { status: 404 });
    }
    if (msg.includes("exported")) {
      return NextResponse.json(
        { error: msg || "Trip is exported and cannot be changed." },
        { status: 409 },
      );
    }
    console.error("[api/receipts/trips/[id]] PATCH failed", error);
    return NextResponse.json(
      { error: msg || "Failed to update trip." },
      { status: 500 },
    );
  }
}
