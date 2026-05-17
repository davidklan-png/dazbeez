import type { AmexStatementLine, ReceiptRecord } from "./types";

export interface StatementWindow {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD
}

/**
 * Derive a statement window from actual line transaction dates.
 *
 * When lines have valid dates, the window spans [min - slack, max + slack].
 * When no valid dates exist, falls back to a calendar heuristic:
 *   month-1 25th → month+3days (e.g. "2026-03" → 2026-02-25 … 2026-03-03).
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
    return { start: iso(min), end: iso(max) };
  }

  // Calendar heuristic fallback
  const [yearStr, monthStr] = statementMonth.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr); // 1-based

  const start = new Date(Date.UTC(year, month - 2, 25)); // previous month 25th
  const end = new Date(Date.UTC(year, month - 1, 3));    // current month 3rd
  return { start: iso(start), end: iso(end) };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * True if the receipt has no date or its transaction_date falls within [start, end].
 */
export function isReceiptInWindow(
  receipt: ReceiptRecord,
  window: StatementWindow,
): boolean {
  if (!receipt.transaction_date) return true;
  return receipt.transaction_date >= window.start && receipt.transaction_date <= window.end;
}
