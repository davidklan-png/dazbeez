import { notFound } from "next/navigation";
import {
  buildExportBundle,
  validateMonthReadyForExport,
} from "@/lib/receipts/month-closing";
import {
  getExport,
  getFinalizedReconciliationForMonth,
  listAmexLines,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import {
  computeExportBlockers,
  computeExportWarnings,
} from "@/lib/receipts/blockers";
import { deriveStatementWindow } from "@/lib/receipts/statement-window";
import { formatMonth } from "@/lib/receipts/format";
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
  // PR #72). monthReceipts (month-scoped) feeds only the tile's pending /
  // unreviewed / unknown counts.
  const [bundle, currentExport, reconciliation, monthLines, monthReceipts] =
    await Promise.all([
      buildExportBundle(month),
      getExport(month),
      getFinalizedReconciliationForMonth(month),
      listAmexLines(month),
      listReceiptRecords({ month, limit: 1000 }),
    ]);

  const window =
    monthLines.length > 0 ? deriveStatementWindow(monthLines, month) : null;

  // Authoritative gate verdict — pass the prebuilt bundle + reconciliation so
  // the gate doesn't re-fetch them.
  const gateBlockers = await validateMonthReadyForExport(
    month,
    bundle,
    reconciliation ?? null,
  );
  const tileBlockers = computeExportBlockers(
    monthReceipts,
    monthLines,
    bundle.receipts,
  );
  const warnings = computeExportWarnings(monthLines);

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
    />
  );
}
