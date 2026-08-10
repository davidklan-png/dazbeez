import { notFound } from "next/navigation";
import {
  buildExportBundle,
  validateMonthReadyForExportDetailed,
} from "@/lib/receipts/month-closing";
import { derivePackNoticeInput } from "@/lib/receipts/proofs";
import { buildPackNames, type PackNames } from "@/lib/receipts/pack-naming";
import {
  getExport,
  getFinalizedReconciliationForMonth,
  listAmexLines,
  listAmexLinesForBusinessTripReports,
  listBusinessTripReports,
} from "@/lib/receipts/db";
import { listUnknownInScopeReceipts } from "@/lib/receipts/membership";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import {
  computeExportBlockers,
  computeDuplicateReceiptWarnings,
  computeExportWarnings,
  computeIcCardTopUpWarnings,
} from "@/lib/receipts/blockers";
import { deriveStatementWindow } from "@/lib/receipts/statement-window";
import { formatMonth } from "@/lib/receipts/format";
import { listCategoryRules } from "@/lib/receipts/category-rules";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { ReviewScreen } from "@/components/receipts/export/review-screen";

export const dynamic = "force-dynamic";

type Params = Promise<{ month: string }>;

export default async function ReviewPage({ params }: { params: Params }) {
  await assertReceiptsPageAccess();
  const { month } = await params;
  if (!/^\d{4}-\d{2}$/.test(month)) notFound();

  // Same sources the finalize gate uses: buildExportBundle (single row-assembly
  // authority) + listReceiptRecordsByIds-by-way-of-bundle.receipts for matched
  // receipts (never month-scoped receipts for line-category resolution — see
  // PR #72). monthReceipts (membership in-scope: bundle ∪ UNKNOWN-in-window)
  // feeds only the tile's pending / unreviewed / unknown counts.
  const [bundle, currentExport, reconciliation, monthLines, unknownInScope, tripReports] =
    await Promise.all([
      buildExportBundle(month),
      getExport(month),
      getFinalizedReconciliationForMonth(month),
      listAmexLines(month),
      listUnknownInScopeReceipts(month),
      listBusinessTripReports(month),
    ]);
  // ADR 0006 (PR #2): tile counting set = in-scope receipts for M = the bundle
  // (matched AMEX + CASH/DIGITAL assigned to M) ∪ UNKNOWN in M's natural window
  // — the same set the finalize gate (validateMonthReadyForExport) uses for its
  // unreviewed check, so the tile and gate cannot drift.
  const monthReceipts = [...bundle.receipts, ...unknownInScope];
  const tripLines = await listAmexLinesForBusinessTripReports(
    tripReports.map((r) => r.id),
  );

  const window =
    monthLines.length > 0 ? deriveStatementWindow(monthLines, month) : null;

  // Authoritative gate verdict — pass the prebuilt bundle + reconciliation so
  // the gate doesn't re-fetch them. Detailed (ExportBlocker[]) so the review
  // screen can render gate 1 as a link to Reconcile instead of dead prose.
  const gateBlockers = await validateMonthReadyForExportDetailed(
    month,
    bundle,
    reconciliation ?? null,
  );
  const tileBlockers = computeExportBlockers(
    monthReceipts,
    monthLines,
    bundle.receipts,
  );
  const warnings = [
    ...computeExportWarnings(monthLines),
    ...computeDuplicateReceiptWarnings(monthReceipts),
    ...computeIcCardTopUpWarnings(monthReceipts),
  ];

  // Active category pattern rules → live suggestion affordance on unmatched,
  // uncategorized AMEX lines (ADR: category-rules).
  const categoryRules = (await listCategoryRules(getReceiptsDb())).map((r) => ({
    matchType: r.match_type,
    matchValue: r.match_value,
    expenseCategoryCode: r.expense_category_code,
  }));

  // E2: notice input + pack names for the preface editor's live preview. The
  // operatorMessage field is overridden client-side with the live draft; these
  // are the month-static inputs. names needs the AMEX payment-due date — when
  // it's unavailable (an AMEX month whose draft predates the 0035 snapshot)
  // buildPackNames throws and the preview is hidden (names=null), not crashed.
  const prefaceNoticeInput = derivePackNoticeInput(month, bundle.rows, {
    rowCount: bundle.rows.length,
    receiptCount: bundle.receipts.length,
  });
  let prefaceNames: PackNames | null = null;
  try {
    const hasAmex = bundle.rows.some((r) => r.rowType === "amex_line");
    prefaceNames = buildPackNames(
      month,
      currentExport?.payment_due_date ?? null,
      hasAmex,
    );
  } catch {
    prefaceNames = null;
  }

  return (
    <ReviewScreen
      month={month}
      monthLabel={formatMonth(month)}
      window={window}
      rows={bundle.rows}
      receipts={bundle.receipts}
      currentExport={currentExport}
      reconciliationSealed={Boolean(reconciliation)}
      gateBlockers={gateBlockers}
      tileBlockers={tileBlockers}
      warnings={warnings}
      tripReports={tripReports}
      tripLines={tripLines}
      categoryRules={categoryRules}
      prefaceNoticeInput={prefaceNoticeInput}
      prefaceNames={prefaceNames}
    />
  );
}
