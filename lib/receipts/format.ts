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
