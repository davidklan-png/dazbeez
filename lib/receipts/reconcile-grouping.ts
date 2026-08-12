// Rail-section grouping for the AMEX Reconcile screen. Lifted out of
// reconcile-screen.tsx so the settled-vs-needs-attention split is a single
// pure, unit-testable rule instead of a status comparison spelled out
// separately at the header count and at each rail section filter.
//
// June-2026 review defect this corrects: the header already counted a
// `no_receipt` line as confirmed (`=== "confirmed" || === "no_receipt"`), but
// the rail section filters keyed only on `!== "confirmed"`, so a settled
// `no_receipt` line fell through every section filter and landed in
// "Needs attention" — producing "32 of 32 confirmed" alongside a spurious
// "Needs attention · 3". A `no_receipt` line carries no auto-match, so
// bandForLine assigns it band "none", which groupReview catches. The fix is
// one predicate used everywhere the settled/attention boundary is drawn.

import type { AmexStatementLine, ReconciliationMatch } from "@/lib/receipts/types";
import type { ConfidenceBand } from "@/lib/receipts/confidence";

/** A line the operator has settled — terminal AND complete.
 *
 *  `confirmed` is settled unconditionally. `no_receipt` is settled ONLY when it
 *  carries a non-empty `receipt_missing_reason`: a reasonless `no_receipt` is
 *  incomplete (the finalize gate's evaluateAmexLineSignoff emits `missing_reason`
 *  for it — "missing receipt requires a reason"), so it stays in Needs attention
 *  until the operator supplies one. This keeps such lines out of the confirmed
 *  count and visible, instead of wearing a gray "done" pill that the sign-off
 *  gate then rejects. Single source of truth for the header count and the rail
 *  grouping (see module header). */
export function isSettled(line: AmexStatementLine): boolean {
  if (line.match_status === "confirmed") return true;
  if (line.match_status === "no_receipt") {
    return !!line.receipt_missing_reason?.trim();
  }
  return false;
}

export interface LineWithBand {
  line: AmexStatementLine;
  band: ConfidenceBand;
  match: ReconciliationMatch | undefined;
}

export interface ReconcileLineGroups {
  review: LineWithBand[];
  likely: LineWithBand[];
  obvious: LineWithBand[];
  confirmed: LineWithBand[];
}

/** Split banded AMEX lines into the four rail sections. Every settled line
 *  (confirmed OR no_receipt) lands in `confirmed`; the review / likely /
 *  obvious sections contain only lines still awaiting an operator decision.
 *  A settled line keeps whatever pill its match_status already renders in
 *  LineRow (gray "no receipt expected" vs green "confirmed") — this helper
 *  only decides the section, not the pill. Pure. */
export function groupLinesByStatus(lines: LineWithBand[]): ReconcileLineGroups {
  return {
    review: lines.filter(
      (l) => (l.band === "review" || l.band === "none") && !isSettled(l.line),
    ),
    likely: lines.filter((l) => l.band === "likely" && !isSettled(l.line)),
    obvious: lines.filter((l) => l.band === "obvious" && !isSettled(l.line)),
    confirmed: lines.filter((l) => isSettled(l.line)),
  };
}
