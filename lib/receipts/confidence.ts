// Confidence bands for AMEX line ↔ receipt match suggestions.
// Lifted out of reconcile-screen so thresholds, labels and colours have a
// single home and can be referenced from blockers / dashboard summaries.

import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

export type ConfidenceBand = "obvious" | "likely" | "review" | "none";

export const BAND_THRESHOLDS: Record<ConfidenceBand, [number, number]> = {
  obvious: [0.92, 1],
  likely: [0.7, 0.9199],
  review: [0.01, 0.6999],
  none: [0, 0],
};

export const BAND_DISPLAY: Record<
  ConfidenceBand,
  { dot: string; label: string; tone: "green" | "amber" | "red" | "gray" }
> = {
  obvious: { dot: "bg-green-500", label: "Obvious", tone: "green" },
  likely: { dot: "bg-amber-500", label: "Likely", tone: "amber" },
  review: { dot: "bg-red-500", label: "Review", tone: "red" },
  none: { dot: "bg-gray-300", label: "No match", tone: "gray" },
};

/** Pick the band for a line given its (optional) best match score. */
export function bandForLine(
  line: AmexStatementLine,
  match: { confidenceScore: number } | undefined,
): ConfidenceBand {
  if (!match) {
    if (line.match_status === "confirmed") return "obvious";
    return "none";
  }
  const s = match.confidenceScore;
  if (s >= BAND_THRESHOLDS.obvious[0]) return "obvious";
  if (s >= BAND_THRESHOLDS.likely[0]) return "likely";
  return "review";
}

/**
 * Human-readable explanation of why a line/receipt pair is or isn't a clean
 * match. Used by the reconcile detail pane.
 */
export function matchExplanation(
  line: AmexStatementLine,
  receipt: ReceiptRecord | null,
  /** All confirmed lines sharing this receipt (consolidated 領収書 group). */
  confirmedSiblings: AmexStatementLine[] = [],
): string {
  if (!receipt) return "Pick a receipt or mark as no-receipt-expected.";
  if (confirmedSiblings.length >= 2 && receipt.amount_minor != null) {
    const sum = confirmedSiblings.reduce((total, l) => total + l.amount_minor, 0);
    if (sum === receipt.amount_minor) {
      return `Consolidated receipt — ${confirmedSiblings.length} lines sum to the receipt total.`;
    }
    return `Consolidated receipt — ${confirmedSiblings.length} lines sum to ${sum}, receipt total is ${receipt.amount_minor}. Link the remaining charges before sign-off.`;
  }
  // Foreign-currency match (migration 0026): a JPY statement line carrying a
  // parsed foreign amount matched a USD (etc.) receipt on the FOREIGN amount,
  // not the JPY total. Compare foreign_amount_minor to the receipt amount and
  // explain it as a foreign link — otherwise a valid match reads as "Amount
  // differs" because the JPY total ≠ the receipt's cents.
  const foreignMatch =
    line.memo_currency_parse_status === "parsed" &&
    line.foreign_currency != null &&
    line.foreign_amount_minor != null &&
    line.foreign_currency.toUpperCase() === receipt.currency.toUpperCase();
  if (foreignMatch) {
    if (line.foreign_amount_minor !== (receipt.amount_minor ?? 0))
      return "Foreign-currency amount differs — verify before confirming.";
    if (
      line.transaction_date &&
      receipt.transaction_date &&
      line.transaction_date !== receipt.transaction_date
    )
      return "Dates differ slightly — common for late captures.";
    return "Linked match (foreign currency).";
  }
  if (line.amount_minor !== (receipt.amount_minor ?? 0))
    return "Amount differs — verify before confirming.";
  if (
    line.transaction_date &&
    receipt.transaction_date &&
    line.transaction_date !== receipt.transaction_date
  )
    return "Dates differ slightly — common for late captures.";
  return "Linked match.";
}
