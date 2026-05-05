import { listAmexLines, listAmexArtifacts } from "@/lib/receipts/db";
import { AmexImportForm } from "@/components/receipts/amex-import-form";

export const dynamic = "force-dynamic";

const NETANSWER_URL = "https://www.saisoncard.co.jp/customer-support/netanswer/";

export default async function AmexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const month = String(params.month ?? new Date().toISOString().slice(0, 7));

  let lines: Awaited<ReturnType<typeof listAmexLines>> = [];
  let artifacts: Awaited<ReturnType<typeof listAmexArtifacts>> = [];
  let loadError: string | null = null;
  try {
    [lines, artifacts] = await Promise.all([listAmexLines(month), listAmexArtifacts()]);
  } catch {
    loadError = "Could not load statement data.";
  }

  const counts = {
    total: lines.length,
    unmatched: lines.filter((l) => l.match_status === "unmatched").length,
    confirmed: lines.filter((l) => l.match_status === "confirmed").length,
    noReceipt: lines.filter((l) => l.match_status === "no_receipt").length,
    uncategorized: lines.filter((l) => l.expense_category === "unknown").length,
  };

  const recentArtifacts = artifacts.slice(0, 6);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">AMEX Import</h2>
          <p className="mt-1 text-sm text-gray-500">
            Download from{" "}
            <a
              href={NETANSWER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-600 underline hover:text-amber-700"
            >
              Netアンサー
            </a>
            , then upload here.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-gray-500">
          Upload statement
        </p>
        <AmexImportForm />
      </div>

      {loadError && (
        <p className="text-sm text-red-600">{loadError}</p>
      )}

      {counts.total > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">
            {month} — {counts.total} statement lines
          </h3>
          <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            <Stat label="Unmatched" value={counts.unmatched} warn={counts.unmatched > 0} />
            <Stat label="Confirmed" value={counts.confirmed} />
            <Stat label="No receipt" value={counts.noReceipt} />
            <Stat label="Uncategorized" value={counts.uncategorized} warn={counts.uncategorized > 0} />
          </dl>
          <div className="mt-4 text-center">
            <a
              href="/receipts/reconcile"
              className="text-sm text-amber-600 underline hover:text-amber-700"
            >
              Open reconciliation →
            </a>
          </div>
        </div>
      )}

      {recentArtifacts.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">Upload history</h3>
          <div className="overflow-hidden rounded-xl border border-gray-100">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2">Month</th>
                  <th className="px-3 py-2">File</th>
                  <th className="px-3 py-2">Lines</th>
                  <th className="px-3 py-2">Total</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recentArtifacts.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-900">{a.statement_month}</td>
                    <td className="max-w-[160px] truncate px-3 py-2 text-gray-600">
                      {a.original_filename ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{a.transaction_count ?? "—"}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {a.statement_total_amount_cents != null
                        ? `¥${a.statement_total_amount_cents.toLocaleString()}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={a.import_status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: number;
  warn?: boolean;
}) {
  return (
    <div className="rounded-xl bg-gray-50 p-3">
      <p className={`text-2xl font-bold ${warn && value > 0 ? "text-amber-600" : "text-gray-900"}`}>
        {value}
      </p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    uploaded: "bg-gray-100 text-gray-600",
    parsed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    replaced: "bg-yellow-100 text-yellow-700",
    archived: "bg-gray-200 text-gray-500",
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 font-medium ${styles[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}
