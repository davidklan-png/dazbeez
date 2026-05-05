import { listAmexLines, listReceiptRecords } from "@/lib/receipts/db";
import { matchAmexToReceipts } from "@/lib/receipts/reconciliation";
import { ReconciliationTable } from "@/components/receipts/reconciliation-table";

export const dynamic = "force-dynamic";

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const month = String(params.month ?? new Date().toISOString().slice(0, 7));

  const [amexLines, receipts] = await Promise.all([
    listAmexLines(month),
    listReceiptRecords({ paymentPath: "AMEX", limit: 200 }),
  ]);

  const autoMatches = matchAmexToReceipts(amexLines, receipts);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Reconciliation</h2>
        <p className="mt-1 text-sm text-gray-500">
          Match AMEX statement lines to captured receipts for {month}.
        </p>
      </div>

      <ReconciliationTable
        amexLines={amexLines}
        receipts={receipts}
        autoMatches={autoMatches}
      />
    </div>
  );
}
