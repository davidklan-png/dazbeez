// Cross-month AMEX-claim policy for the Reconcile screen (audit 2026-07-21
// Phase 1, Part B).
//
// Problem: the reconcile page used to build its "linked receipt" set from the
// DISPLAYED month's lines only. A receipt confirmed in a DIFFERENT statement
// month — but whose transaction_date falls inside the displayed month's padded
// window, and whose receipt.status has drifted off "reconciled" — leaked in as
// an orphan or a match candidate. The 2026-07-21 audit found exactly this
// (NFCTAGS receipt confirmed in 2026-07, status stuck at "reviewed", appearing
// as a 2026-08 orphan).
//
// Fix: the AMEX line relationship is authoritative — never receipt.status. A
// receipt claimed by a matched/confirmed line in another statement month is
// excluded from the displayed month's match candidates AND its orphan set.
//
// Pure + client-safe (type-only import) so the NFCTAGS shape is unit-tested
// without D1.

import type { AmexStatementLine } from "@/lib/receipts/types";

/**
 * Receipt ids claimed by a matched/confirmed AMEX line in a statement month
 * OTHER than `displayedMonth`. These receipts are reconciled elsewhere and must
 * not be offered as an automatic match or shown as an orphan in the displayed
 * month.
 *
 * Only real claims count: match_status "matched" (tentative) or "confirmed".
 * A stale "unmatched"/"no_receipt" line still carrying a matched_receipt_id
 * does not exclude the receipt.
 */
export function crossMonthClaimedReceiptIds(
  claims: AmexStatementLine[],
  displayedMonth: string,
): Set<string> {
  const out = new Set<string>();
  for (const line of claims) {
    if (
      line.statement_month !== displayedMonth &&
      line.matched_receipt_id &&
      (line.match_status === "matched" || line.match_status === "confirmed")
    ) {
      out.add(line.matched_receipt_id);
    }
  }
  return out;
}

/**
 * Every receipt id claimed by ANY matched/confirmed AMEX line (any month) — the
 * authoritative "is this receipt already matched" set, used by the AMEX
 * duplicate helper to word its "compare with matched receipt" badge. Unlike
 * crossMonthClaimedReceiptIds this includes the displayed month's own links too.
 */
export function allClaimedReceiptIds(claims: AmexStatementLine[]): Set<string> {
  const out = new Set<string>();
  for (const line of claims) {
    if (
      line.matched_receipt_id &&
      (line.match_status === "matched" || line.match_status === "confirmed")
    ) {
      out.add(line.matched_receipt_id);
    }
  }
  return out;
}
