import { notFound } from "next/navigation";
import { getAmexArtifactById, listAmexLines } from "@/lib/receipts/db";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { formatAmountMinor, formatDate } from "@/lib/receipts/format";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { Pill } from "@/components/ui/pill";
import { amexMatchStatusPill } from "@/lib/receipts/amex-match-status";

export const dynamic = "force-dynamic";

export default async function AmexStatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await assertReceiptsPageAccess();

  const { id } = await params;
  const artifact = await getAmexArtifactById(getReceiptsDb(), id);
  if (!artifact) notFound();

  // Lines are keyed by statement month: if a month was re-uploaded this shows
  // the month's current live lines (current status), not a CSV snapshot.
  let lines: Awaited<ReturnType<typeof listAmexLines>> = [];
  let loadError: string | null = null;
  try {
    lines = await listAmexLines(artifact.statement_month);
  } catch {
    loadError = "Could not load statement lines.";
  }

  return (
    <div className="space-y-6 px-8 py-8">
      <div>
        <a
          href="/receipts/amex"
          className="text-sm text-amber-600 underline hover:text-amber-700"
        >
          ← AMEX Import
        </a>
        <h2 className="mt-2 text-[26px] font-bold text-gray-900">
          {artifact.statement_month} — {lines.length} lines
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          {artifact.original_filename ?? "—"}
        </p>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="overflow-hidden rounded-xl border border-gray-100">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Merchant</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lines.length === 0 ? (
                <tr>
                  <td className="px-3 py-2 text-gray-500" colSpan={5}>
                    No lines for this statement month.
                  </td>
                </tr>
              ) : (
                lines.map((line) => {
                  const pill = amexMatchStatusPill(line.match_status);
                  return (
                    <tr key={line.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                        {formatDate(line.transaction_date)}
                      </td>
                      <td className="max-w-[280px] truncate px-3 py-2 text-gray-700">
                        {line.merchant}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                        {formatAmountMinor(line.amount_minor, line.currency)}
                      </td>
                      <td className="px-3 py-2">
                        <Pill tone={pill.tone} dot>
                          {pill.label}
                        </Pill>
                      </td>
                      <td className="px-3 py-2">
                        {line.matched_receipt_id ? (
                          <a
                            href={`/receipts/review/${line.matched_receipt_id}`}
                            className="text-amber-600 underline hover:text-amber-700"
                          >
                            Review
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
