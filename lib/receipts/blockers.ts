// Blocker / warning summarisation for the monthly export flow.
// Hoisted out of app/(receipt-system)/receipts/export/page.tsx so the same
// rules can power the dashboard "Export status" tile and the reconcile
// screen's "Ready to seal?" summary without forking the logic.
//
// PRESENTATION ONLY. These tiles describe why a month isn't ready so the
// operator knows what to fix; they are not the API gate. The single
// enforcement authority is validateMonthReadyForExport() in
// lib/receipts/month-closing.ts — every finalize path (POST
// /api/receipts/export/month, POST /api/receipts/export/[month]) routes
// through it. If you add a new rule, add it THERE, not here.

import { requiresAttendees } from "@/lib/receipts/categories";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import { resolveLineCategory } from "@/lib/receipts/line-classification";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

// ─── Shared predicates (tile ⇄ gate) ─────────────────────────────────────
// Pure rules shared between the export tile (computeExportBlockers) and the
// finalize gate (validateMonthReadyForExportCore + validateAmexLinesForSignoff)
// so a rule can never exist in one and not the other. The gate is the
// authority; the tile mirrors these exactly. Add a rule here AND wire it into
// the gate if it should block finalize.

/** A line is uncategorized when neither it nor its matched receipt carries a
 * category (resolveLineCategory — the same authority the gate uses). */
export function isUncategorizedLine(
  line: Pick<AmexStatementLine, "matched_receipt_id" | "expense_category_code">,
  receipt:
    | Pick<ReceiptRecord, "expense_category_code" | "deleted_at">
    | undefined
    | null,
): boolean {
  return !resolveLineCategory(line, receipt);
}

/** A receipt blocks on unknown payment path (finalize gate 2). */
export function isUnknownPathReceipt(
  receipt: Pick<ReceiptRecord, "payment_path">,
): boolean {
  return receipt.payment_path === "UNKNOWN";
}

/** A receipt is an unreviewed blocker: needs review and not still pending
 * extraction (gate 2.5). Pending receipts are a separate "drain the queue"
 * nudge, not an unreviewed blocker. */
export function isUnreviewedReceipt(receipt: ReceiptRecord): boolean {
  return receipt.status === "needs_review" && !isPendingProcessing(receipt);
}

export type BlockerSeverity = "blocker" | "warn";

export type Blocker = {
  severity: BlockerSeverity;
  count: number;
  label: string;
  detail: string;
  href: string | null;
  ctaLabel: string;
};

export function computeExportBlockers(
  receipts: ReceiptRecord[],
  lines: AmexStatementLine[],
  // Receipts fetched by matched_receipt_id, unscoped by month (a line may be
  // matched to a receipt dated in a different statement month). Used ONLY for
  // category resolution: unioned into the receipt map so a cross-month matched
  // receipt's category resolves the line — matching the finalize gate, which
  // builds its receiptMap from bundle.receipts (the same ID-fetched set).
  // `receipts` (month-scoped) still drives the pending / unreviewed / unknown
  // counts below. Kept pure: callers do the DB fetch (listReceiptRecordsByIds
  // or reuse bundle.receipts); this function does no I/O.
  matchedReceipts: ReceiptRecord[] = [],
): Blocker[] {
  const blockers: Blocker[] = [];

  // Category authority is the matched receipt, not the line, for confirmed
  // matches (resolveLineCategory — the same authority
  // validateAmexLinesForSignoff / month-closing use). Counting the raw line
  // field over-reported "uncategorized" whenever a matched receipt already
  // carried the category, desynchronizing this tile from the finalize gate.
  // The map unions the month-scoped receipts with the ID-fetched matched
  // receipts so cross-month matches resolve (the fix for the 2026-06 "27
  // uncategorized" that were all matched to April/May receipts).
  const receiptMap = new Map<string, ReceiptRecord>();
  for (const r of receipts) receiptMap.set(r.id, r);
  for (const r of matchedReceipts) receiptMap.set(r.id, r);
  const uncategorized = lines.filter((l) => {
    const receipt = l.matched_receipt_id
      ? receiptMap.get(l.matched_receipt_id)
      : undefined;
    return isUncategorizedLine(l, receipt);
  }).length;
  if (uncategorized > 0) {
    blockers.push({
      severity: "blocker",
      count: uncategorized,
      label: "Uncategorized AMEX lines",
      detail: "Pick an expense category for each line.",
      href: "/receipts/reconcile",
      ctaLabel: "Fix in Reconcile",
    });
  }

  // payment_path='UNKNOWN' receipts are excluded from the export bundle by
  // design (their export month is ambiguous) and block finalize at
  // validateMonthReadyForExport gate 2. Surface them here so the tile and the
  // gate agree in this direction too — previously a month could read "clear"
  // on the tile yet 422 on finalize. `receipts` is month-scoped, matching the
  // gate's `transaction_date LIKE month%` filter.
  const unknownPath = receipts.filter(isUnknownPathReceipt).length;
  if (unknownPath > 0) {
    blockers.push({
      severity: "blocker",
      count: unknownPath,
      label: "Receipts with unknown payment path",
      detail: "Classify as AMEX, CASH, or DIGITAL before sealing.",
      href: "/receipts/review?payment_path=UNKNOWN",
      ctaLabel: "Fix in Review",
    });
  }

  // ADR 0001: "pending processing" is distinct from "unreviewed". A captured
  // receipt still in the extraction queue has no field key yet and cannot be
  // matched — surfacing it as a missing/unreviewed receipt would send someone
  // chasing a receipt we already hold. The fix is to drain the queue (run the
  // Mac consumer), not to review or re-capture.
  const pendingProcessing = receipts.filter(isPendingProcessing).length;
  if (pendingProcessing > 0) {
    blockers.push({
      severity: "blocker",
      count: pendingProcessing,
      label: "Receipts pending processing",
      detail: "Captured but not yet extracted. Drain the queue on the Mac.",
      href: "/receipts/review",
      ctaLabel: "Process queue",
    });
  }

  const unreviewed = receipts.filter(isUnreviewedReceipt).length;
  if (unreviewed > 0) {
    blockers.push({
      severity: "blocker",
      count: unreviewed,
      label: "Unreviewed receipts",
      detail: "These receipts must be reviewed before sealing.",
      href: "/receipts/review?status=needs_review",
      ctaLabel: "Fix in Review",
    });
  }

  const attendeesMissing = lines.filter(
    (l) => requiresAttendees(l.expense_category_code) && !l.matched_receipt_id,
  ).length;
  if (attendeesMissing > 0) {
    blockers.push({
      severity: "blocker",
      count: attendeesMissing,
      label: "Entertainment/meeting lines need attendees",
      detail: "Link a receipt that has attendees recorded.",
      href: "/receipts/reconcile",
      ctaLabel: "Fix in Reconcile",
    });
  }

  const missingReason = lines.filter(
    (l) => l.receipt_status === "missing_receipt" && !l.receipt_missing_reason,
  ).length;
  if (missingReason > 0) {
    blockers.push({
      severity: "blocker",
      count: missingReason,
      label: 'Lines marked "missing receipt" without a reason',
      detail: "Add a brief reason so audit can defend the claim.",
      href: "/receipts/reconcile",
      ctaLabel: "Fix in Reconcile",
    });
  }

  return blockers;
}

export function computeExportWarnings(lines: AmexStatementLine[]): Blocker[] {
  const warnings: Blocker[] = [];

  const tripCandidates = lines.filter(
    (l) => l.business_trip_status === "candidate",
  ).length;
  if (tripCandidates > 0) {
    warnings.push({
      severity: "warn",
      count: tripCandidates,
      label: "Unresolved business-trip candidates",
      detail: "Confirm or dismiss the trip cluster.",
      href: "/receipts/reconcile",
      ctaLabel: "Open trips",
    });
  }

  const noReceipt = lines.filter((l) => l.match_status === "no_receipt").length;
  if (noReceipt > 0) {
    warnings.push({
      severity: "warn",
      count: noReceipt,
      label: 'AMEX lines marked "no receipt expected"',
      detail: "These ship as-is; not a blocker.",
      href: null,
      ctaLabel: "Acknowledge",
    });
  }

  return warnings;
}

/**
 * Non-blocking warning when 2+ CASH/DIGITAL receipts share merchant +
 * amount_minor + transaction_date (e.g. several ¥10,000 Seven-Eleven charges
 * on the same day). ADR 0006 §D9 / PR #3. Warning only — no auto-dedup, not a
 * finalize blocker. Deep-links to the first offending receipt's edit view.
 *
 * Receipts not in the CASH/DIGITAL paths, or missing merchant/amount/date, are
 * ignored (they can't form a duplicate cluster on these keys).
 */
export function computeDuplicateReceiptWarnings(
  receipts: ReceiptRecord[],
): Blocker[] {
  const groups = new Map<string, ReceiptRecord[]>();
  for (const r of receipts) {
    if (r.payment_path !== "CASH" && r.payment_path !== "DIGITAL") continue;
    if (!r.transaction_date || r.merchant == null || r.amount_minor == null) continue;
    const key = `${r.merchant} ${r.amount_minor} ${r.transaction_date}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const clusters = [...groups.values()].filter((g) => g.length >= 2);
  if (clusters.length === 0) return [];
  const totalFlagged = clusters.reduce((s, g) => s + g.length, 0);
  const first = clusters[0]![0]!;
  return [
    {
      severity: "warn",
      count: totalFlagged,
      label: "Possible duplicate cash/digital receipts",
      detail:
        `${clusters.length} cluster(s) share merchant + amount + date ` +
        `(e.g. ${first.merchant} ×${clusters[0]!.length} on ${first.transaction_date}). ` +
        `Confirm these are distinct charges, not double-captured.`,
      href: `/receipts/review/${first.id}`,
      ctaLabel: "Open first",
    },
  ];
}
