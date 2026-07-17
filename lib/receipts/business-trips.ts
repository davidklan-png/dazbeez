// Pure helpers for business-trip management (ADR 0010). Kept D1-free so the
// overlap decision, status-sync, and input/transition validation are unit-
// testable without mocks — same factoring doctrine as amex-line-patch.ts.
//
// Phase A scope: detection dedupe, CRUD/membership validation, status sync.
// No UI, no export artifact (Phase B/C).

import type { BusinessTripStatus } from "@/lib/receipts/types";

/** YYYY-MM-DD lexical comparison is a correct chronological ordering. */
export function rangesOverlap(
  a: { start: string; end: string },
  b: { start: string; end: string },
): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Union (min start, max end) of two date ranges. */
export function unionRange(
  a: { start: string; end: string },
  b: { start: string; end: string },
): { start: string; end: string } {
  return {
    start: a.start < b.start ? a.start : b.start,
    end: a.end > b.end ? a.end : b.end,
  };
}

export interface ExistingTrip {
  id: string;
  cardholder_name: string;
  start_date: string;
  end_date: string;
  status: string;
}

/**
 * Detection dedupe (ADR 0010 D1): find an existing trip for the SAME
 * cardholder whose [start_date, end_date] overlaps the candidate's range and
 * whose status is 'candidate' or 'confirmed' (a rejected or exported trip does
 * not absorb new lines). Returns the first match or null.
 */
export function findOverlappingTrip(
  candidate: { cardholderName: string; startDate: string; endDate: string },
  existing: ExistingTrip[],
): ExistingTrip | null {
  for (const trip of existing) {
    if (
      trip.cardholder_name === candidate.cardholderName &&
      (trip.status === "candidate" || trip.status === "confirmed") &&
      rangesOverlap(
        { start: candidate.startDate, end: candidate.endDate },
        { start: trip.start_date, end: trip.end_date },
      )
    ) {
      return trip;
    }
  }
  return null;
}

/**
 * Given an overlapping existing trip + the candidate range, decide whether the
 * trip's stored range should be widened to the union. Widening is allowed ONLY
 * for status='candidate' — a confirmed trip is never silently widened (the
 * operator confirmed specific dates). Returns the action + (when widen) the
 * new range.
 */
export function decideWiden(
  trip: ExistingTrip,
  candidate: { startDate: string; endDate: string },
): { kind: "widen"; range: { start: string; end: string } } | { kind: "skip" } | { kind: "none" } {
  const u = unionRange(
    { start: trip.start_date, end: trip.end_date },
    { start: candidate.startDate, end: candidate.endDate },
  );
  const wouldChange = u.start !== trip.start_date || u.end !== trip.end_date;
  if (!wouldChange) return { kind: "none" };
  if (trip.status === "candidate") return { kind: "widen", range: u };
  return { kind: "skip" }; // confirmed trip — never silently widen
}

// ─── Status sync (ADR 0010 D4) ──────────────────────────────────────────────

export type TripTransition = "confirmed" | "rejected";

/**
 * Pure helper: the per-line updates to apply when a trip transitions.
 *   confirm → member lines 'confirmed' (business_trip_id stays = tripId)
 *   reject  → member lines 'excluded' + business_trip_id = NULL
 * Receipt members have no status and survive both (handled by the caller).
 */
export function computeTripStatusLineUpdates(
  tripId: string,
  memberLineIds: string[],
  transition: TripTransition,
): Array<{
  lineId: string;
  businessTripId: string | null;
  businessTripStatus: "confirmed" | "excluded";
}> {
  if (transition === "confirmed") {
    return memberLineIds.map((lineId) => ({
      lineId,
      businessTripId: tripId,
      businessTripStatus: "confirmed",
    }));
  }
  return memberLineIds.map((lineId) => ({
    lineId,
    businessTripId: null,
    businessTripStatus: "excluded",
  }));
}

// ─── Input + transition validation (route-facing) ───────────────────────────

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateTripDates(
  startDate: string,
  endDate: string,
): ValidationResult {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return { ok: false, error: "startDate and endDate must be YYYY-MM-DD." };
  }
  if (startDate > endDate) {
    return { ok: false, error: "startDate must be on or before endDate." };
  }
  return { ok: true };
}

/**
 * ADR 0010 D4 status transitions. The trip screen owns candidate→confirmed |
 * rejected. 'exported' is terminal (set only by Phase C export integration) —
 * any transition FROM it is rejected (409). Same-status (idempotent) is allowed.
 */
export function validateTripTransition(
  current: BusinessTripStatus,
  next: BusinessTripStatus,
): ValidationResult {
  if (current === "exported") {
    return { ok: false, error: "Trip is exported and cannot be changed." };
  }
  if (next !== "confirmed" && next !== "rejected") {
    return { ok: false, error: "status must be 'confirmed' or 'rejected'." };
  }
  return { ok: true };
}
