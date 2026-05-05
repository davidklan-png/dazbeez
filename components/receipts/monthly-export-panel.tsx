"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReceiptExport } from "@/lib/receipts/types";

interface MonthlyExportPanelProps {
  exports: ReceiptExport[];
  currentMonth: string;
}

export function MonthlyExportPanel({
  exports,
  currentMonth,
}: MonthlyExportPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentExport = exports.find((e) => e.export_month === currentMonth);

  async function handleGenerate() {
    setBusy("generate");
    setError(null);
    try {
      const res = await fetch("/api/receipts/export/month", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month: currentMonth }),
      });
      const json = (await res.json()) as { error?: string; sha256?: string };
      if (!res.ok) { setError(json.error ?? "Generation failed."); return; }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  async function handleFinalize(month: string) {
    setBusy(`finalize-${month}`);
    setError(null);
    try {
      const res = await fetch(`/api/receipts/export/${month}`, {
        method: "POST",
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) { setError(json.error ?? "Finalization failed."); return; }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Current month */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">{currentMonth}</h3>
            <p className="text-sm text-gray-500">
              {currentExport
                ? currentExport.status === "finalized"
                  ? "Finalized"
                  : "Draft — not yet finalized"
                : "Not yet generated"}
            </p>
          </div>
          {currentExport?.status === "finalized" && (
            <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
              Finalized
            </span>
          )}
        </div>

        {currentExport ? (
          <dl className="mb-4 space-y-1 text-xs text-gray-500">
            {currentExport.archive_sha256 && (
              <div className="flex gap-2">
                <dt className="font-medium">SHA-256:</dt>
                <dd className="truncate font-mono">{currentExport.archive_sha256}</dd>
              </div>
            )}
            {currentExport.finalized_at && (
              <div className="flex gap-2">
                <dt className="font-medium">Finalized:</dt>
                <dd>{currentExport.finalized_at.slice(0, 16).replace("T", " ")}</dd>
              </div>
            )}
          </dl>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {!currentExport && (
            <button
              disabled={busy === "generate"}
              onClick={handleGenerate}
              className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
            >
              {busy === "generate" ? "Generating…" : "Generate export"}
            </button>
          )}

          {currentExport?.status === "draft" && (
            <>
              <button
                disabled={!!busy}
                onClick={handleGenerate}
                className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                {busy === "generate" ? "Regenerating…" : "Regenerate"}
              </button>
              <button
                disabled={!!busy}
                onClick={() => handleFinalize(currentMonth)}
                className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-60"
              >
                {busy === `finalize-${currentMonth}` ? "Finalizing…" : "Finalize export"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Export history */}
      {exports.filter((e) => e.export_month !== currentMonth).length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">History</h3>
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                  <th className="px-4 py-3">Month</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">SHA-256</th>
                  <th className="px-4 py-3">Finalized</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {exports
                  .filter((e) => e.export_month !== currentMonth)
                  .map((e) => (
                    <tr key={e.id}>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {e.export_month}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                            e.status === "finalized"
                              ? "bg-green-100 text-green-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {e.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">
                        {e.archive_sha256
                          ? `${e.archive_sha256.slice(0, 12)}…`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {e.finalized_at
                          ? e.finalized_at.slice(0, 10)
                          : "—"}
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
