import {
  listAmexLines,
  listReceiptRecords,
  getReconciliationForMonth,
  listAmexLineCountsByMonth,
  listReconciliationStatusByMonth,
} from "@/lib/receipts/db";
import { matchAmexToReceipts } from "@/lib/receipts/reconciliation";
import {
  deriveStatementWindow,
  isReceiptInWindow,
} from "@/lib/receipts/statement-window";
import { ReconcileScreen } from "@/components/receipts/reconcile/reconcile-screen";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import type { MonthOption } from "@/components/receipts/month-switcher";
import { formatMonth } from "@/lib/receipts/format";

export const dynamic = "force-dynamic";

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await assertReceiptsPageAccess();

  const params = await searchParams;
  const requestedMonth =
    typeof params.month === "string" ? params.month : null;

  const [lineCountsByMonth, reconciliationStatusByMonth] = await Promise.all([
    listAmexLineCountsByMonth(),
    listReconciliationStatusByMonth(),
  ]);

  const availableMonths: MonthOption[] = [...lineCountsByMonth.entries()]
    .map(([month, counts]) => ({
      month,
      lineCount: counts.total,
      unmatchedCount: counts.unmatched,
      status: reconciliationStatusByMonth.get(month) ?? null,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const month =
    requestedMonth ??
    (availableMonths.length > 0
      ? availableMonths[availableMonths.length - 1]!.month
      : new Date().toISOString().slice(0, 7));

  const [amexLines, receipts, reconciliation] = await Promise.all([
    listAmexLines(month),
    listReceiptRecords({ paymentPath: "AMEX", limit: 200 }),
    getReconciliationForMonth(month),
  ]);

  const window = amexLines.length > 0 ? deriveStatementWindow(amexLines, month) : null;
  const receiptsInWindow = window
    ? receipts.filter((r) => isReceiptInWindow(r, window))
    : receipts;

  const finalized = reconciliation?.status === "finalized";
  const autoMatches = finalized
    ? []
    : matchAmexToReceipts(amexLines, receiptsInWindow);

  const linkedReceiptIds = new Set(
    amexLines
      .map((l) => l.matched_receipt_id)
      .filter((id): id is string => Boolean(id)),
  );
  const suggestedReceiptIds = new Set(autoMatches.map((m) => m.receiptId));
  const orphanReceipts = receiptsInWindow.filter(
    (r) =>
      r.payment_path === "AMEX" &&
      r.status !== "archived" &&
      r.status !== "exported" &&
      r.status !== "reconciled" &&
      !r.deleted_at &&
      !linkedReceiptIds.has(r.id) &&
      !suggestedReceiptIds.has(r.id),
  );

  return (
    <ReconcileScreen
      amexLines={amexLines}
      receipts={receipts}
      autoMatches={autoMatches}
      orphanReceipts={orphanReceipts}
      month={month}
      monthLabel={formatMonth(month)}
      monthsAvailable={availableMonths}
      finalized={finalized}
      finalizedAt={reconciliation?.finalized_at ?? null}
      window={window}
      receiptsInWindow={receiptsInWindow}
    />
  );
}

