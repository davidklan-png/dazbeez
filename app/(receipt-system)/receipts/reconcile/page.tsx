import {
  listAmexLines,
  listReceiptRecords,
  getReconciliationForMonth,
  listAmexLineCountsByMonth,
  listReconciliationStatusByMonth,
} from "@/lib/receipts/db";
import { matchAmexToReceipts } from "@/lib/receipts/reconciliation";
import { deriveStatementWindow, isReceiptInWindow } from "@/lib/receipts/statement-window";
import { ReconciliationTable } from "@/components/receipts/reconciliation-table";
import { MonthSwitcher, type MonthOption } from "@/components/receipts/month-switcher";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";

export const dynamic = "force-dynamic";

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await assertReceiptsPageAccess();

  const params = await searchParams;
  const requestedMonth = typeof params.month === "string" ? params.month : null;

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

  // Default to the latest month with lines if no explicit ?month=, falling back
  // to today's calendar month only if nothing has been imported yet.
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

  const window = deriveStatementWindow(amexLines, month);
  const receiptsInWindow = receipts.filter((r) => isReceiptInWindow(r, window));

  const autoMatches = reconciliation?.status === "finalized"
    ? [] // No auto-matching when finalized
    : matchAmexToReceipts(amexLines, receiptsInWindow);

  const linkedReceiptIds = new Set(
    amexLines
      .map((l) => l.matched_receipt_id)
      .filter((id): id is string => !!id),
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

  const counts = {
    total: amexLines.length,
    confirmed: amexLines.filter((l) => l.match_status === "confirmed").length,
    pending: amexLines.filter(
      (l) => l.match_status === "unmatched" || l.match_status === "matched",
    ).length,
    noReceipt: amexLines.filter((l) => l.match_status === "no_receipt").length,
    orphans: orphanReceipts.length,
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Reconciliation</h2>
        <p className="mt-1 text-sm text-gray-500">
          Match AMEX statement lines to captured receipts.
        </p>
      </div>

      <MonthSwitcher
        months={availableMonths}
        activeMonth={month}
        basePath="/receipts/reconcile"
      />

      {amexLines.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <p className="text-sm text-gray-600">
            No AMEX lines found for <span className="font-mono">{month}</span>.
          </p>
          <a
            href="/receipts/amex"
            className="mt-3 inline-block rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600"
          >
            Import a statement CSV
          </a>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatBox label="Total lines" value={counts.total} />
            <StatBox label="Pending" value={counts.pending} warn={counts.pending > 0} />
            <StatBox label="Confirmed" value={counts.confirmed} good={counts.confirmed > 0} />
            <StatBox label="No receipt" value={counts.noReceipt} />
            <StatBox label="Orphan receipts" value={counts.orphans} warn={counts.orphans > 0} />
          </div>

          {reconciliation?.status === "finalized" && (
            <div className="rounded-2xl border border-green-200 bg-green-50 p-4">
              <p className="text-sm font-semibold text-green-800">
                Reconciliation signed off
              </p>
              <p className="mt-1 text-xs text-green-700">
                Finalized by {reconciliation.finalized_by} at {reconciliation.finalized_at}
                {" — "}{reconciliation.line_count} lines ({reconciliation.matched_count} matched, {reconciliation.no_receipt_count} no receipt)
              </p>
              {reconciliation.manifest_sha256 && (
                <p className="mt-1 text-xs font-mono text-green-600">
                  SHA-256: {reconciliation.manifest_sha256}
                </p>
              )}
              <a
                href={`/api/receipts/reconcile/${month}/manifest`}
                className="mt-2 inline-block text-xs font-medium text-amber-700 hover:text-amber-800 underline"
              >
                Download manifest CSV
              </a>
            </div>
          )}

          <ReconciliationTable
            amexLines={amexLines}
            receipts={receipts}
            autoMatches={autoMatches}
            orphanReceipts={orphanReceipts}
            month={month}
            finalized={reconciliation?.status === "finalized"}
            window={window}
            receiptsInWindow={receiptsInWindow}
          />
        </>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  warn = false,
  good = false,
}: {
  label: string;
  value: number;
  warn?: boolean;
  good?: boolean;
}) {
  const valueClass =
    warn && value > 0
      ? "text-amber-600"
      : good && value > 0
        ? "text-green-700"
        : "text-gray-900";
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 text-center shadow-sm">
      <p className={`text-2xl font-bold ${valueClass}`}>{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}
