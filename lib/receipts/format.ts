// Shared formatters for the receipts module. Extracted from per-page
// duplicates so dashboard, amex, export and reconcile render months and
// amounts identically.

/**
 * Format a YYYY-MM string as "October 2026".
 * Falls back to the raw input if the month string is malformed.
 */
export function formatMonth(month: string): string {
  try {
    const [y, m] = month.split("-").map(Number);
    if (!y || !m) return month;
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  } catch {
    return month;
  }
}

/**
 * Format a YYYY-MM string as Japanese "2026年10月" — for surfaces where the
 * month label sits inside a Japanese sentence (the delivery composer header
 * "2026年6月 の送信", the sealed-undelivered banner, the dashboard alert).
 * `formatMonth` is en-US ("June 2026"); using it inside a Japanese sentence
 * produced the mixed-locale "June 2026 の送信" slip (delivery-composer §D).
 * Falls back to the raw input if the month string is malformed.
 */
export function formatMonthJa(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return `${y}年${m}月`;
}

/**
 * Format a minor-unit amount as JPY ("¥1,234") when no currency is given
 * or when the currency is JPY. Other currencies are rendered with two
 * decimals and the ISO code.
 */
export function formatAmountMinor(
  amountMinor: number,
  currency: string | null = "JPY",
): string {
  if (!currency || currency === "JPY") return `¥${amountMinor.toLocaleString()}`;
  return `${(amountMinor / 100).toFixed(2)} ${currency}`;
}

/**
 * Pretty label for the payment path enum used throughout the receipts UI.
 */
export function formatPaymentPath(path: string | null | undefined): string {
  switch (path) {
    case "AMEX":
      return "AMEX";
    case "CASH":
      return "Cash";
    case "DIGITAL":
      return "Digital";
    default:
      return path ?? "—";
  }
}

/**
 * The epoch-ms of the start of the operator's current JST calendar day,
 * expressed in UTC ms (so `new Date(result).toISOString()` is the correct bind
 * for a `captured_at >= ?` comparison against UTC-stored timestamps). JST has no
 * DST, so a constant +09:00 shift is exact: shift to JST wall-clock ms, floor to
 * the day, shift back. Matches the +9h convention in currentCalendarMonth().
 */
export function jstDayStartUtcMs(nowMs: number): number {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  return (
    Math.floor((nowMs + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS
  );
}

/**
 * The ISO (UTC) timestamp of the start of the operator's current JST day — the
 * lower bound for "captured today" counts. Defaults to now; tests pass an
 * explicit epoch to make the day boundary deterministic.
 */
export function startOfJstDayIso(now: Date = new Date()): string {
  return new Date(jstDayStartUtcMs(now.getTime())).toISOString();
}

/**
 * Format a YYYY-MM-DD date as "Oct 12, 2026". Falls back to the raw input.
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  try {
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
