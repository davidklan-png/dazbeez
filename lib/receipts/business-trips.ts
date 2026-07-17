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

// ─── Attach-candidate picker (ADR 0010 D2) ───────────────────────────────────
// Trip dates describe the trip, not the charge window — prebooking charges
// before and service-provider charges after are the norm, spanning months. The
// picker defaults to trip dates ± `window` days (cross-month by construction),
// with a "show all" escape. Window/date arithmetic lives here (pure, tested);
// the db function narrows in SQL for efficiency.

/** Parse a YYYY-MM-DD string to a UTC-midnight Date (no TZ drift). */
function parseIsoDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

/** YYYY-MM-DD shifted by `days` (can be negative). */
export function shiftDate(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** [start_date − windowDays, end_date + windowDays] — the default charge list. */
export function candidateWindow(
  trip: { startDate: string; endDate: string },
  windowDays: number,
): { start: string; end: string } {
  return {
    start: shiftDate(trip.startDate, -windowDays),
    end: shiftDate(trip.endDate, windowDays),
  };
}

/** Inclusive window membership (YYYY-MM-DD lexical compare = chronological). */
export function isInCandidateWindow(
  date: string,
  window: { start: string; end: string },
): boolean {
  return date >= window.start && date <= window.end;
}

export interface CandidateRow {
  kind: "line" | "receipt";
  id: string;
  transactionDate: string | null;
  merchant: string | null;
  amountMinor: number | null;
  currency: string;
  /** statement_month for lines; export_statement_month or calendar month for receipts. */
  month: string | null;
  /** line match_status / receipt status. */
  status: string | null;
  /** Lines only: the trip currently owning this line (business_trip_id), if any.
   *  A different-trip owner is INCLUDED but flagged so the UI can show why attach 409s. */
  ownedByTripId: string | null;
}

/**
 * Pure picker filter: drops current members of THIS trip, applies the date
 * window (unless null = "show all"), and the merchant search `q`. Used by the
 * candidates route after the db function narrows by window+q in SQL.
 */
export function filterAttachCandidates(
  rows: CandidateRow[],
  opts: {
    memberLineIds: Set<string>;
    memberReceiptIds: Set<string>;
    window: { start: string; end: string } | null;
    q: string;
  },
): CandidateRow[] {
  const qLower = opts.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (row.kind === "line" && opts.memberLineIds.has(row.id)) return false;
    if (row.kind === "receipt" && opts.memberReceiptIds.has(row.id)) return false;
    if (
      opts.window &&
      row.transactionDate &&
      !isInCandidateWindow(row.transactionDate, opts.window)
    ) {
      return false;
    }
    if (qLower && !(row.merchant ?? "").toLowerCase().includes(qLower)) {
      return false;
    }
    return true;
  });
}

/**
 * Why a candidate row is not attachable right now (for the UI's disabled-state
 * helper text). Pure so it can be unit-tested alongside the picker.
 */
export function candidateDisableReason(
  row: CandidateRow,
  tripId: string,
): string | null {
  if (row.kind === "line" && row.ownedByTripId && row.ownedByTripId !== tripId) {
    return `Owned by another trip — detach it there first.`;
  }
  return null;
}

// ─── Pure UI helpers (trips screen) ──────────────────────────────────────────

export type TripTab = "candidate" | "confirmed" | "all";

/** Candidates tab shows candidate; Confirmed shows confirmed; All shows all
 *  (rejected trips appear only under All). */
export function filterTripsByTab<T extends { status: string }>(
  trips: T[],
  tab: TripTab,
): T[] {
  if (tab === "all") return trips;
  return trips.filter((t) => t.status === tab);
}

/** Pill tone for a trip status (candidate=amber, confirmed=green, rejected=gray,
 *  exported=blue). Pure so the list + detail screens + tests share one map. */
export function tripStatusTone(
  status: string,
): "amber" | "green" | "gray" | "blue" {
  switch (status) {
    case "candidate":
      return "amber";
    case "confirmed":
      return "green";
    case "exported":
      return "blue";
    default:
      return "gray"; // rejected + unknown
  }
}
