import type { AmexStatementLine, ReceiptRecord } from "./types";

export interface StatementWindow {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
  source: "lines" | "fallback";
}

/**
 * Derive a statement window from actual line transaction dates.
 *
 * Saison/Netアンサー statements are labelled by the month they're due, but
 * the transactions they contain post over the prior ~6 weeks. A March
 * statement covers charges from roughly late December through early
 * February — never March itself.
 *
 * When lines have valid dates, the window spans [min - slack, max + slack]
 * (source: "lines").
 *
 * When no lines have dates (statement not yet uploaded, or parse failed),
 * fall back to a calendar heuristic of (month-3, day 20) through
 * (month-1, day 10) — e.g. "2026-03" → 2025-12-20 … 2026-02-10
 * (source: "fallback").
 */
export function deriveStatementWindow(
  lines: AmexStatementLine[],
  statementMonth: string,
  slackDays = 5,
): StatementWindow {
  const dates = lines
    .map((l) => l.transaction_date)
    .filter((d): d is string => !!d)
    .sort();

  if (dates.length > 0) {
    const min = new Date(dates[0]!);
    const max = new Date(dates[dates.length - 1]!);
    min.setDate(min.getDate() - slackDays);
    max.setDate(max.getDate() + slackDays);
    return { start: iso(min), end: iso(max), source: "lines" };
  }

  // Calendar heuristic fallback. Date.UTC normalizes negative month indices
  // into prior years, so e.g. Date.UTC(2026, -1, 20) → 2025-12-20.
  const [yearStr, monthStr] = statementMonth.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-based

  const start = new Date(Date.UTC(year, month - 4, 20));
  const end = new Date(Date.UTC(year, month - 2, 10));
  return { start: iso(start), end: iso(end), source: "fallback" };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * True if the receipt has no date or its transaction_date falls within [start, end].
 */
export function isReceiptInWindow(
  receipt: ReceiptRecord,
  window: { start: string; end: string },
): boolean {
  if (!receipt.transaction_date) return true;
  return receipt.transaction_date >= window.start && receipt.transaction_date <= window.end;
}

// ─── Calendar-month membership (ADR 0008) ─────────────────────────────────
//
// DISTINCT from the slack-5 MATCH window above (deriveStatementWindow /
// isReceiptInWindow), which is used only to find receipt candidates that *might*
// match AMEX lines during reconcile. That match window is untouched.
//
// A CASH/DIGITAL receipt's EXPORT month is the CALENDAR month of its
// transaction_date (June 11 → 2026-06), stored on
// receipt_records.export_statement_month (migration 0020). This RETIRES the
// ADR 0006 statement-cycle-window rule (window(M) = (close(M-1), close(M)]
// chained from AMEX line closes): a cash receipt now ships in the same calendar
// month as its date, sitting alongside that month's AMEX statement — whose own
// lines span the PRIOR billing cycle. That asymmetry is intentional and
// operator-confirmed (2026-07-13). See docs/adr/0008-…md.
//
// These functions are PURE (no D1, no Date.now/random). The only thing that
// persists a membership decision is the export_statement_month column, written by
// the capture path (createReceiptRecord), the date-set hook
// (updateReceiptRecord), the discretionary override (PATCH /api/receipts/[id]),
// and the one-time policy migration (scripts/migrate-membership-to-calendar-month.ts).
//
// Sticky / freeze rule (carried over from ADR 0006, restated): an assigned
// receipt is never re-derived by the automatic hooks. The capture/date-set
// assignment UPDATEs are gated on `WHERE export_statement_month IS NULL`, so an
// already-assigned receipt is structurally invisible to re-derivation. The only
// mutation after assignment is an operator override. Calendar month removes the
// original drift risk entirely — membership no longer depends on AMEX line data,
// so no boundary can shift — which is why ADR 0006's drift detection is retired.

/** Increment a YYYY-MM by n months (n may be negative). Pure. */
export function incrementMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/**
 * The calendar month (YYYY-MM) of a YYYY-MM-DD transaction_date — the ADR 0008
 * "natural month". Returns null for null/empty/malformed input so callers can
 * pass the raw column value through without conditional branches. This replaced
 * ADR 0006's naturalStatementMonth (a window lookup).
 */
export function naturalMonth(
  transactionDate: string | null | undefined,
): string | null {
  if (!transactionDate) return null;
  const m = /^(\d{4}-\d{2})/.exec(transactionDate);
  return m ? m[1]! : null;
}

export type AssignmentReason = "natural" | "roll-forward";

export interface AssignmentResult {
  /** The assigned export month (YYYY-MM). Always non-null: a dated receipt is
   *  always assignable under the calendar rule (roll-forward finds an open
   *  month, or falls back to natural). */
  month: string;
  reason: AssignmentReason;
  /** The natural month when the result is a roll-forward. */
  rolledFrom?: string;
}

/** Upper bound on the roll-forward walk. With 3–4 concurrent open months
 *  (ADR 0005, no hard runtime cap) this is never reached; it only guards
 *  against a pathological all-months-sealed state. */
const ROLL_FORWARD_MAX_MONTHS = 24;

/**
 * Assign a receipt's export month per ADR 0008.
 *
 *   1. natural = naturalMonth(date). A null date is "unassignable" (undated) and
 *      is handled by the caller — this function is only called with a non-null
 *      date. natural is therefore always defined here.
 *   2. natural not sealed ⇒ { natural, "natural" }.
 *   3. natural sealed + rollForward ⇒ walk forward by calendar month to the
 *      first month NOT in sealedMonths:
 *        found  ⇒ { that month, "roll-forward", rolledFrom: natural }
 *        bounded walk exhausted (cannot happen with 3–4 concurrent open months) ⇒ fall back
 *        to { natural, "natural" } so the receipt is never left unassigned.
 *   4. natural sealed + !rollForward ⇒ { natural, "natural" } (UNKNOWN path: an
 *      UNKNOWN receipt must be classified before it gets a real export month, so
 *      it never rolls — it keeps its natural month and blocks at gate 2).
 *
 * @param sealedMonths export months that have SHIPPED and cannot be reopened —
 *  `receipt_exports.status='finalized'` with no open draft revision (the
 *  isMonthLockedForEdits condition, month-lock.ts). CASH/DIGITAL only (policy).
 */
export function assignReceiptMembership(
  date: string,
  sealedMonths: Set<string>,
  opts: { rollForward: boolean },
): AssignmentResult {
  const natural = naturalMonth(date);
  // Defensive: callers guard null dates (undated = unassignable, skipped). If a
  // null/ malformed date reaches here, treat the empty month as "natural" so the
  // caller's NULL-only UPDATE writes nothing meaningful — but this never fires
  // in practice because assignMembershipForReceipt checks the date first.
  if (natural === null) return { month: "", reason: "natural" };
  if (!sealedMonths.has(natural)) return { month: natural, reason: "natural" };

  // Natural month is sealed.
  if (!opts.rollForward) return { month: natural, reason: "natural" };

  // Walk forward by calendar month to the first non-sealed month.
  for (let i = 1; i <= ROLL_FORWARD_MAX_MONTHS; i++) {
    const candidate = incrementMonth(natural, i);
    if (!sealedMonths.has(candidate)) {
      return { month: candidate, reason: "roll-forward", rolledFrom: natural };
    }
  }
  // Every month in range is sealed (pathological). Fall back to natural so the
  // receipt is never silently unassigned; the operator can override.
  return { month: natural, reason: "natural" };
}
