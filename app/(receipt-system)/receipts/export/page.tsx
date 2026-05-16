import Link from "next/link";
import {
  listExports,
  listReceiptRecords,
  listAmexLines,
} from "@/lib/receipts/db";
import { requiresAttendees } from "@/lib/receipts/categories";
import { MonthlyExportPanel } from "@/components/receipts/monthly-export-panel";

export const dynamic = "force-dynamic";

export default async function ExportPage() {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const [exports, monthReceipts, monthLines] = await Promise.all([
    listExports(),
    listReceiptRecords({ month: currentMonth, limit: 1000 }),
    listAmexLines(currentMonth),
  ]);

  // Pre-flight blockers — surface the same conditions the export route uses
  // so the user sees them BEFORE clicking Generate, not after.
  const unreviewed = monthReceipts.filter(
    (r) => r.status === "captured" || r.status === "needs_review",
  ).length;
  const uncategorized = monthLines.filter(
    (l) => !l.expense_category_code,
  ).length;
  const missingReason = monthLines.filter(
    (l) => l.receipt_status === "missing_receipt" && !l.receipt_missing_reason,
  ).length;
  const attendeesMissing = monthLines.filter(
    (l) =>
      requiresAttendees(l.expense_category_code) && !l.matched_receipt_id,
  ).length;
  const tripCandidates = monthLines.filter(
    (l) => l.business_trip_status === "candidate",
  ).length;

  const totalBlockers =
    unreviewed + uncategorized + missingReason + attendeesMissing + tripCandidates;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Monthly Export</h2>
        <p className="mt-1 text-sm text-gray-500">
          Generate and archive the accountant bundle. Finalized exports are
          locked and cannot be overwritten.
        </p>
      </div>

      {totalBlockers > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-semibold">
            {totalBlockers} {totalBlockers === 1 ? "item" : "items"} to resolve
            before {currentMonth} can be finalized
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {unreviewed > 0 && (
              <li>
                • {unreviewed} receipt{unreviewed !== 1 ? "s" : ""} not yet
                reviewed —{" "}
                <Link href="/receipts/review" className="font-semibold underline">
                  Review →
                </Link>
              </li>
            )}
            {uncategorized > 0 && (
              <li>
                • {uncategorized} AMEX line{uncategorized !== 1 ? "s" : ""}{" "}
                missing expense category —{" "}
                <Link
                  href="/receipts/reconcile"
                  className="font-semibold underline"
                >
                  Reconcile →
                </Link>
              </li>
            )}
            {missingReason > 0 && (
              <li>
                • {missingReason} line{missingReason !== 1 ? "s" : ""} marked
                &quot;missing receipt&quot; without a reason —{" "}
                <Link
                  href="/receipts/reconcile"
                  className="font-semibold underline"
                >
                  Reconcile →
                </Link>
              </li>
            )}
            {attendeesMissing > 0 && (
              <li>
                • {attendeesMissing} entertainment/meeting line
                {attendeesMissing !== 1 ? "s" : ""} need attendees recorded —{" "}
                <Link
                  href="/receipts/reconcile"
                  className="font-semibold underline"
                >
                  Reconcile →
                </Link>
              </li>
            )}
            {tripCandidates > 0 && (
              <li>
                • {tripCandidates} unresolved business-trip candidate
                {tripCandidates !== 1 ? "s" : ""} —{" "}
                <Link
                  href="/receipts/reconcile"
                  className="font-semibold underline"
                >
                  Reconcile →
                </Link>
              </li>
            )}
          </ul>
        </div>
      )}

      <MonthlyExportPanel exports={exports} currentMonth={currentMonth} />
    </div>
  );
}
