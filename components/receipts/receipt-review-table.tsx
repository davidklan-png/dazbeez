"use client";

import { useState } from "react";
import Link from "next/link";
import type { ReceiptRecord } from "@/lib/receipts/types";

interface ReceiptReviewTableProps {
  receipts: ReceiptRecord[];
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    captured: "bg-gray-100 text-gray-600",
    needs_review: "bg-amber-100 text-amber-700",
    reviewed: "bg-blue-100 text-blue-700",
    reconciled: "bg-green-100 text-green-700",
    exported: "bg-purple-100 text-purple-700",
    archived: "bg-gray-200 text-gray-500",
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

export function ReceiptReviewTable({ receipts }: ReceiptReviewTableProps) {
  const [rows, setRows] = useState<ReceiptRecord[]>(receipts);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleConfirmDelete(id: string) {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/receipts/${id}`, { method: "DELETE" });
      const json = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok) {
        setDeleteError(json.error ?? "Delete failed.");
        return;
      }

      setRows((prev) => prev.filter((r) => r.id !== id));
      setConfirmId(null);
    } catch {
      setDeleteError("Network error — please try again.");
    } finally {
      setDeleting(false);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
        No receipts yet.{" "}
        <Link href="/receipts/capture" className="text-amber-600 underline">
          Capture your first receipt
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Merchant</th>
            <th className="px-4 py-3">Amount</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            confirmId === r.id ? (
              <tr key={r.id} className="bg-red-50">
                <td colSpan={6} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-gray-700">
                      Delete this receipt? This removes it from review and prevents it from being included in exports.
                    </span>
                    <button
                      type="button"
                      onClick={() => handleConfirmDelete(r.id)}
                      disabled={deleting}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                    >
                      {deleting ? "Deleting…" : "Confirm delete"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setConfirmId(null); setDeleteError(null); }}
                      disabled={deleting}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-60"
                    >
                      Cancel
                    </button>
                    {deleteError && (
                      <span className="text-xs text-red-600">{deleteError}</span>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-700">
                  {r.transaction_date ?? <span className="text-gray-400">—</span>}
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {r.merchant ?? <span className="text-gray-400">—</span>}
                </td>
                <td className="px-4 py-3 text-gray-700">
                  {r.amount_minor !== null ? (
                    <>
                      {r.currency === "JPY"
                        ? r.amount_minor.toLocaleString()
                        : (r.amount_minor / 100).toFixed(2)}{" "}
                      {r.currency}
                    </>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500">{r.expense_type}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Link
                      href={`/receipts/review/${r.id}`}
                      className="text-amber-600 hover:underline"
                    >
                      Review
                    </Link>
                    <button
                      type="button"
                      onClick={() => { setConfirmId(r.id); setDeleteError(null); }}
                      className="text-gray-400 hover:text-red-500"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            )
          ))}
        </tbody>
      </table>
    </div>
  );
}
