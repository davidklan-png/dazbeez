import {
  listAmexLines,
  listReceiptRecords,
  getReconciliationForMonth,
} from "@/lib/receipts/db";
import { matchAmexToReceipts } from "@/lib/receipts/reconciliation";
import { ReconciliationTable } from "@/components/receipts/reconciliation-table";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import type { AmexReconciliation } from "@/lib/receipts/types";

export const dynamic = "force-dynamic";

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await assertReceiptsPageAccess();

  const params = await searchParams;
  const month = String(params.month ?? new Date().toISOString().slice(0, 7));

  const [amexLines, receipts, reconciliation] = await Promise.all([
    listAmexLines(month),
    listReceiptRecords({ paymentPath: "AMEX", limit: 200 }),
    getReconciliationForMonth(month),
  ]);

  const autoMatches = reconciliation?.status === "finalized"
    ? [] // No auto-matching when finalized
    : matchAmexToReceipts(amexLines, receipts);

  const linkedReceiptIds = new Set(
    amexLines
      .map((l) => l.matched_receipt_id)
      .filter((id): id is string => !!id),
  );
  const suggestedReceiptIds = new Set(autoMatches.map((m) => m.receiptId));
  const orphanReceipts = receipts.filter(
    (r) =>
      r.payment_path === "AMEX" &&
      r.status !== "archived" &&
      r.status !== "exported" &&
      !r.deleted_at &&
      (!r.transaction_date || r.transaction_date.startsWith(month)) &&
      !linkedReceiptIds.has(r.id) &&
      !suggestedReceiptIds.has(r.id),
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Reconciliation</h2>
        <p className="mt-1 text-sm text-gray-500">
          Match AMEX statement lines to captured receipts for {month}.
        </p>
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
      />
    </div>
  );
}
