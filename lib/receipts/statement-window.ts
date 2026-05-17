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
