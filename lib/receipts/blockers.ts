// Blocker / warning summarisation for the monthly export flow.
// Hoisted out of app/(receipt-system)/receipts/export/page.tsx so the same
// rules can power the dashboard "Export status" tile and the reconcile
// screen's "Ready to seal?" summary without forking the logic.

import { requiresAttendees } from "@/lib/receipts/categories";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

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
): Blocker[] {
  const blockers: Blocker[] = [];

  const uncategorized = lines.filter((l) => !l.expense_category_code).length;
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

  const unreviewed = receipts.filter(
    (r) => r.status === "captured" || r.status === "needs_review",
  ).length;
  if (unreviewed > 0) {
    blockers.push({
      severity: "blocker",
      count: unreviewed,
      label: "Unreviewed receipts",
      detail: "These receipts must be reviewed before sealing.",
      href: "/receipts/review",
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
