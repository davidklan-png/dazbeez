import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";
import { resolveAttendeeNames } from "@/lib/receipts/attendee-directory";
import { requiresAttendees } from "@/lib/receipts/categories";

// Backlog #6 (one-shot Part D): the single source for the attendees gate logic.
// The finalize gate (`validateMonthReadyForExportCore`'s receipt loop, for
// CASH/DIGITAL receipts) and the AMEX-line signoff checker
// (`evaluateAmexLineSignoff`, for receipts matched to AMEX lines) previously
// each inlined the SAME logic — `requiresAttendees(category)` then, when
// attendees are present, `resolveAttendeeNames` to find unresolved names. With
// the seal-only path retired, the finalize gate is the sole sealing authority,
// so duplicate rule implementations are more dangerous than they were (no second
// path to cross-check). Both callers now go through this predicate.
//
// The two callers differ only in WHAT they feed in: the gate passes a receipt's
// category + its attendees; the AMEX checker passes the line-resolved category +
// the union of receipt- and line-level attendees. The decision is identical, so
// it lives here once. Each caller maps the result to its own output shape
// (ExportBlocker codes for the gate; AmexLineSignoffCode for the AMEX checker).

/** The outcome of the attendees requirement check for one category + attendee set. */
export interface AttendeeRequirementResult {
  /** false ⇒ the category needs no attendees — no attendee checks apply. */
  required: boolean;
  /** Whether any attendee names were provided. When `required` is true and this
   *  is false, the signal is "attendees_required" (missing); when true, the
   *  signal is "attendee_unresolved" for each name in `unresolved`. */
  attendeesPresent: boolean;
  /** Attendee names that did NOT resolve to a directory entry. Empty when all
   *  resolve, or when no attendees were provided. */
  unresolved: string[];
}

/**
 * Evaluate the attendees requirement for a single category + attendee list
 * against the attendee directory. Pure; unit-testable. This is the one place
 * the attendees gate rule is defined — the finalize gate (CASH/DIGITAL receipts)
 * and `evaluateAmexLineSignoff` (AMEX-matched receipts) both call it, so the two
 * cannot drift.
 */
export function evaluateAttendeeRequirement(
  category: string | null | undefined,
  attendees: string[],
  directory: ReceiptAttendeeDirectoryEntry[],
): AttendeeRequirementResult {
  if (!requiresAttendees(category)) {
  return { required: false, attendeesPresent: false, unresolved: [] };
  }
  if (attendees.length === 0) {
    return { required: true, attendeesPresent: false, unresolved: [] };
  }
  const { unresolved } = resolveAttendeeNames(attendees, directory);
  return { required: true, attendeesPresent: true, unresolved };
}
