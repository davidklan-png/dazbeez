"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AmexStatementLine, ReceiptRecord, AmexExpenseCategory } from "@/lib/receipts/types";
import type { ReconciliationMatch } from "@/lib/receipts/types";

const EXPENSE_CATEGORIES: { value: AmexExpenseCategory; label: string }[] = [
  { value: "unknown", label: "— Select category —" },
  { value: "meeting_no_alcohol", label: "Meeting (no alcohol)" },
  { value: "entertainment_alcohol", label: "Entertainment (alcohol)" },
  { value: "transportation", label: "Transportation" },
  { value: "travel", label: "Travel" },
  { value: "business_trip", label: "Business trip" },
  { value: "books", label: "Books" },
  { value: "research", label: "Research" },
  { value: "software", label: "Software" },
  { value: "telecom", label: "Telecom" },
  { value: "office_supplies", label: "Office supplies" },
  { value: "insurance", label: "Insurance" },
  { value: "misc", label: "Miscellaneous" },
];

const ATTENDEE_REQUIRED: AmexExpenseCategory[] = ["meeting_no_alcohol", "entertainment_alcohol"];

interface ReconciliationTableProps {
  amexLines: AmexStatementLine[];
  receipts: ReceiptRecord[];
  autoMatches: ReconciliationMatch[];
}

export function ReconciliationTable({
  amexLines,
  receipts,
  autoMatches,
}: ReconciliationTableProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryBusy, setCategoryBusy] = useState<string | null>(null);

  const matchMap = new Map<string, ReconciliationMatch>(
    autoMatches.map((m) => [m.amexLineId, m]),
  );

  const receiptMap = new Map<string, ReceiptRecord>(
    receipts.map((r) => [r.id, r]),
  );

  async function reconcile(
    amexLineId: string,
    receiptId: string | null,
    matchStatus: string,
  ) {
    setBusy(amexLineId);
    setError(null);
    try {
      const res = await fetch("/api/receipts/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amexLineId, receiptId, matchStatus }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) { setError(json.error ?? "Failed."); return; }
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(null);
    }
  }

  async function updateCategory(lineId: string, expenseCategory: AmexExpenseCategory) {
    setCategoryBusy(lineId);
    try {
      await fetch(`/api/receipts/amex/lines/${lineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expenseCategory }),
      });
      router.refresh();
    } catch {
      // silently fail — not critical
    } finally {
      setCategoryBusy(null);
    }
  }

  async function updateReceiptStatus(lineId: string, receiptStatus: string, reason?: string) {
    try {
      await fetch(`/api/receipts/amex/lines/${lineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptStatus, receiptMissingReason: reason ?? null }),
      });
      router.refresh();
    } catch {
      // silently fail
    }
  }

  const unmatched = amexLines.filter(
    (l) => l.match_status === "unmatched" || l.match_status === "matched",
  );
  const confirmed = amexLines.filter((l) => l.match_status === "confirmed");
  const noReceipt = amexLines.filter((l) => l.match_status === "no_receipt");

  function formatAmount(line: AmexStatementLine) {
    return line.currency === "JPY"
      ? `¥${line.amount_minor.toLocaleString()}`
      : `${(line.amount_minor / 100).toFixed(2)} ${line.currency}`;
  }

  function receiptLabel(r: ReceiptRecord) {
    const date = r.transaction_date ?? "?";
    const merchant = r.merchant ?? "(no merchant)";
    const amount =
      r.amount_minor !== null
        ? r.currency === "JPY"
          ? `¥${r.amount_minor.toLocaleString()}`
          : `${(r.amount_minor / 100).toFixed(2)} ${r.currency}`
        : "?";
    return `${date} · ${merchant} · ${amount}`;
  }

  function CategoryRow({ line }: { line: AmexStatementLine }) {
    const needsAttendees = ATTENDEE_REQUIRED.includes(line.expense_category);
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={line.expense_category}
          disabled={categoryBusy === line.id}
          onChange={(e) => updateCategory(line.id, e.target.value as AmexExpenseCategory)}
          className={`rounded-lg border px-2 py-1 text-xs focus:border-amber-500 focus:outline-none ${
            line.expense_category === "unknown"
              ? "border-amber-300 bg-amber-50 text-amber-700"
              : "border-gray-200 bg-white text-gray-700"
          }`}
        >
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        {line.expense_category !== "unknown" && line.category_status !== "confirmed" && (
          <span className="text-xs text-gray-400">suggested</span>
        )}
        {needsAttendees && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
            Needs attendees
          </span>
        )}
        {line.business_trip_status === "candidate" && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
            Business trip candidate
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Pending reconciliation */}
      {unmatched.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">
            Pending ({unmatched.length})
          </h3>
          <div className="space-y-3">
            {unmatched.map((line) => {
              const autoMatch = matchMap.get(line.id);
              const suggestedReceipt = autoMatch
                ? receiptMap.get(String(autoMatch.receiptId))
                : null;

              return (
                <div
                  key={line.id}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-gray-900">
                        {line.merchant}
                        {line.cardholder_name && (
                          <span className="ml-2 text-xs font-normal text-gray-400">
                            {line.cardholder_name}
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-gray-500">
                        {line.transaction_date} · {formatAmount(line)}
                      </p>
                      <CategoryRow line={line} />
                    </div>
                    <div className="flex gap-2">
                      <button
                        disabled={busy === line.id}
                        onClick={() => {
                          reconcile(line.id, null, "no_receipt");
                          updateReceiptStatus(line.id, "no_receipt_required");
                        }}
                        className="rounded-xl border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                      >
                        No receipt
                      </button>
                    </div>
                  </div>

                  {suggestedReceipt && (
                    <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3">
                      <p className="text-xs font-medium text-amber-700">
                        Suggested match (
                        {Math.round(autoMatch!.confidenceScore * 100)}% confidence:{" "}
                        {autoMatch!.matchReasons.join(", ")})
                      </p>
                      <p className="mt-1 text-xs text-gray-700">
                        {receiptLabel(suggestedReceipt)}
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          disabled={busy === line.id}
                          onClick={() =>
                            reconcile(line.id, suggestedReceipt.id, "confirmed")
                          }
                          className="rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                        >
                          Confirm match
                        </button>
                        <button
                          disabled={busy === line.id}
                          onClick={() =>
                            reconcile(line.id, suggestedReceipt.id, "matched")
                          }
                          className="rounded-xl border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Mark matched (review later)
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Manual receipt selector */}
                  <div className="mt-3">
                    <select
                      className="block w-full rounded-xl border border-gray-300 px-3 py-2 text-xs text-gray-700 focus:border-amber-500 focus:outline-none"
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) {
                          reconcile(line.id, e.target.value, "confirmed");
                        }
                      }}
                    >
                      <option value="">— Manually link a receipt —</option>
                      {receipts
                        .filter((r) => r.payment_path === "AMEX")
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {receiptLabel(r)}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Confirmed */}
      {confirmed.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">
            Confirmed ({confirmed.length})
          </h3>
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full text-xs">
              <tbody className="divide-y divide-gray-100">
                {confirmed.map((line) => {
                  const r = line.matched_receipt_id
                    ? receiptMap.get(line.matched_receipt_id)
                    : null;
                  return (
                    <tr key={line.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700">{line.transaction_date}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {line.merchant}
                        {line.cardholder_name && (
                          <span className="ml-1 text-gray-400">({line.cardholder_name})</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{formatAmount(line)}</td>
                      <td className="px-4 py-3">
                        <select
                          value={line.expense_category}
                          disabled={categoryBusy === line.id}
                          onChange={(e) =>
                            updateCategory(line.id, e.target.value as AmexExpenseCategory)
                          }
                          className={`rounded-lg border px-2 py-0.5 text-xs focus:border-amber-500 focus:outline-none ${
                            line.expense_category === "unknown"
                              ? "border-amber-300 bg-amber-50 text-amber-700"
                              : "border-gray-200 text-gray-700"
                          }`}
                        >
                          {EXPENSE_CATEGORIES.map((c) => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {r ? receiptLabel(r) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No receipt */}
      {noReceipt.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">
            No receipt ({noReceipt.length})
          </h3>
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full text-xs">
              <tbody className="divide-y divide-gray-100">
                {noReceipt.map((line) => (
                  <tr key={line.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-700">{line.transaction_date}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{line.merchant}</td>
                    <td className="px-4 py-3 text-gray-600">{formatAmount(line)}</td>
                    <td className="px-4 py-3">
                      <select
                        value={line.expense_category}
                        disabled={categoryBusy === line.id}
                        onChange={(e) =>
                          updateCategory(line.id, e.target.value as AmexExpenseCategory)
                        }
                        className={`rounded-lg border px-2 py-0.5 text-xs focus:border-amber-500 focus:outline-none ${
                          line.expense_category === "unknown"
                            ? "border-amber-300 bg-amber-50 text-amber-700"
                            : "border-gray-200 text-gray-700"
                        }`}
                      >
                        {EXPENSE_CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>{c.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <NoReceiptReasonCell line={line} onUpdate={updateReceiptStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {unmatched.length === 0 && confirmed.length === 0 && noReceipt.length === 0 && (
        <p className="text-sm text-gray-500">
          No AMEX lines found. Import a statement CSV first.
        </p>
      )}
    </div>
  );
}

function NoReceiptReasonCell({
  line,
  onUpdate,
}: {
  line: AmexStatementLine;
  onUpdate: (id: string, status: string, reason?: string) => void;
}) {
  const [reason, setReason] = useState(line.receipt_missing_reason ?? "");
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <span className="text-gray-400 hover:underline cursor-pointer" onClick={() => setEditing(true)}>
        {line.receipt_missing_reason ?? "Add reason"}
      </span>
    );
  }

  return (
    <div className="flex gap-1">
      <input
        autoFocus
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason"
        className="rounded border border-gray-300 px-2 py-0.5 text-xs focus:border-amber-500 focus:outline-none"
      />
      <button
        type="button"
        onClick={() => {
          onUpdate(line.id, "no_receipt_required", reason);
          setEditing(false);
        }}
        className="rounded bg-amber-500 px-2 py-0.5 text-xs text-white hover:bg-amber-600"
      >
        Save
      </button>
    </div>
  );
}
