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
): string {
  if (!receipt) return "Pick a receipt or mark as no-receipt-expected.";
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
