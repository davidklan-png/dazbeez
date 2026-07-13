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

// ─── Statement-cycle membership windows (ADR 0006) ─────────────────────────
//
// DISTINCT from the slack-5 MATCH window above. Membership windows are slack-0
// cycle boundaries chained across statements: window(M) = (close(M-1), close(M)]
// where close(M) = MAX(transaction_date) over statement M's AMEX lines (NOT
// payment_due_date — see ADR §D1). A transaction_date maps to exactly one
// window. These functions are PURE (no D1, no Date.now/random); the only thing
// that persists a membership decision is the receipt_records.export_statement_month
// column (migration 0020), written by the capture path / import sweep / backfill.
//
// The freeze rule (ADR §D3): sticky assignments always win over window
// recomputation. It is NOT enforced here — assignReceiptMembership has no
// concept of an existing assignment. It is a caller contract: the import sweep
// only selects `WHERE export_statement_month IS NULL`, so an already-assigned
// receipt is structurally invisible to re-derivation. Pinned by a contract test.

/** A statement's cycle close = the latest transaction_date among its lines. */
export interface StatementClose {
  statementMonth: string; // YYYY-MM
  close: string; // YYYY-MM-DD
}

/**
 * A single membership window. Half-open on the left, closed on the right:
 * window(M) = (startExclusive, endInclusive]. startExclusive is null for the
 * earliest statement (open-ended start). By construction
 * windows[i].startExclusive === windows[i-1].endInclusive, so the chain is
 * contiguous and non-overlapping and any date <= the newest close maps to
 * exactly one window.
 */
export interface MembershipWindow {
  statementMonth: string;
  startExclusive: string | null;
  endInclusive: string;
}

/**
 * Chain statement closes into contiguous (close(M-1), close(M)] windows.
 *
 * Statements are sorted ascending by statementMonth. Only statements with a
 * usable close anchor a window; entries missing statementMonth/close are
 * dropped (a statement with no dated lines cannot anchor a window and would
 * create a gap — ADR §D2). Callers should pass closes derived from
 * `MAX(transaction_date) ... GROUP BY statement_month` (already non-null).
 *
 * Invariants (unit-tested): sorted ascending; for i > 0,
 * windows[i].startExclusive === windows[i-1].endInclusive; windows[0].startExclusive === null.
 */
export function computeStatementWindows(
  closes: StatementClose[],
): MembershipWindow[] {
  const usable = closes
    .filter((c) => !!c && !!c.statementMonth && !!c.close)
    .sort((a, b) =>
      a.statementMonth < b.statementMonth
        ? -1
        : a.statementMonth > b.statementMonth
          ? 1
          : 0,
    );
  const windows: MembershipWindow[] = [];
  let prevClose: string | null = null;
  for (const c of usable) {
    windows.push({
      statementMonth: c.statementMonth,
      startExclusive: prevClose,
      endInclusive: c.close,
    });
    prevClose = c.close;
  }
  return windows;
}

/**
 * The statement month a transaction_date falls in, or null if the date is
 * beyond the newest close ("awaiting statement") or no windows exist.
 *
 * Single-membership by construction: windows are contiguous with inclusive
 * ends and exclusive starts, so the containing window is the one with the
 * smallest endInclusive >= date. A date exactly equal to a close lands in that
 * window (inclusive end), not the next one.
 */
export function assignStatementMonth(
  date: string,
  windows: MembershipWindow[],
): string | null {
  if (!date || windows.length === 0) return null;
  for (const w of windows) {
    // windows are sorted by statementMonth and (by contiguity) by endInclusive.
    if (date <= w.endInclusive) return w.statementMonth;
  }
  return null; // date > newest close → awaiting
}

/**
 * The natural statement month for a date, ignoring sealed-state and
 * roll-forward. Identical to {@link assignStatementMonth}; exposed separately
 * because callers reason about "natural" vs "assigned" (roll-forward) months
 * in different contexts (gate-2 UNKNOWN scoping, the "expected future month"
 * UI hint). See ADR §D4.
 */
export function naturalStatementMonth(
  date: string,
  windows: MembershipWindow[],
): string | null {
  return assignStatementMonth(date, windows);
}

export type AssignmentReason =
  | "natural"
  | "roll-forward"
  | "awaiting"
  | "awaiting-rolled";

export interface AssignmentResult {
  /** The assigned statement month, or null when awaiting. */
  month: string | null;
  reason: AssignmentReason;
  /** The natural month when the result is a roll-forward or rolled-awaiting. */
  rolledFrom?: string;
}

/**
 * Assign a receipt's export statement month per ADR §D3.
 *
 *   1. natural = naturalStatementMonth(date). Null date or null natural → awaiting.
 *   2. natural not sealed → { natural, "natural" }.
 *   3. natural sealed:
 *      - rollForward=false → still { natural, "natural" } (a caller that doesn't
 *        roll, e.g. an UNKNOWN receipt that must be classified before it can
 *        be assigned a real export month).
 *      - rollForward=true  → walk forward through windows to the first month
 *        NOT in sealedMonths:
 *          found          → { that month, "roll-forward", rolledFrom: natural }
 *          walked off end → { null, "awaiting-rolled", rolledFrom: natural }
 *
 * @param sealedMonths finalized statement_months (amex_reconciliations.status='finalized').
 */
export function assignReceiptMembership(
  date: string | null,
  windows: MembershipWindow[],
  sealedMonths: Set<string>,
  opts: { rollForward: boolean },
): AssignmentResult {
  if (!date) return { month: null, reason: "awaiting" };
  const natural = naturalStatementMonth(date, windows);
  if (natural === null) return { month: null, reason: "awaiting" };
  if (!sealedMonths.has(natural)) return { month: natural, reason: "natural" };

  // Natural month is sealed.
  if (!opts.rollForward) return { month: natural, reason: "natural" };

  // Walk forward (windows are sorted by statementMonth) to the first open month.
  const startIdx = windows.findIndex((w) => w.statementMonth === natural);
  for (let i = startIdx + 1; i < windows.length; i++) {
    if (!sealedMonths.has(windows[i]!.statementMonth)) {
      return {
        month: windows[i]!.statementMonth,
        reason: "roll-forward",
        rolledFrom: natural,
      };
    }
  }
  // No newer open statement → awaiting, but record what it would have rolled from.
  return { month: null, reason: "awaiting-rolled", rolledFrom: natural };
}
