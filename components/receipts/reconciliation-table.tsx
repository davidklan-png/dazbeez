"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";
import type { ReconciliationMatch } from "@/lib/receipts/types";
import type { StatementWindow } from "@/lib/receipts/statement-window";
import {
  EXPENSE_CATEGORIES,
  requiresAttendees as categoryRequiresAttendees,
  formatCategoryLabel,
} from "@/lib/receipts/categories";
import { normalizeDescription } from "@/lib/receipts/reconciliation";

interface ReconciliationTableProps {
  amexLines: AmexStatementLine[];
  receipts: ReceiptRecord[];
  autoMatches: ReconciliationMatch[];
  orphanReceipts: ReceiptRecord[];
  month: string;
  finalized?: boolean;
  window?: StatementWindow;
  receiptsInWindow?: ReceiptRecord[];
}

export function ReconciliationTable({
  amexLines,
  receipts,
  autoMatches,
  orphanReceipts,
  month,
  finalized,
  window: stmtWindow,
  receiptsInWindow,
}: ReconciliationTableProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categoryBusy, setCategoryBusy] = useState<string | null>(null);
  const [signoffBusy, setSignoffBusy] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.9);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  const [bulkResult, setBulkResult] = useState<{ confirmed: number; failed: number; errors: string[] } | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Unified lock: any in-flight mutation disables all interactive controls
  const locked = busy !== null || bulkProgress !== null || signoffBusy || !!finalized;

  const matchMap = new Map<string, ReconciliationMatch>(
    autoMatches.map((m) => [m.amexLineId, m]),
  );

  const receiptMap = new Map<string, ReceiptRecord>(
    receipts.map((r) => [r.id, r]),
  );

  async function reconcileFetch(
    amexLineId: string,
    receiptId: string | null,
    matchStatus: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch("/api/receipts/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amexLineId, receiptId, matchStatus }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) return { ok: false, error: json.error ?? "Failed." };
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error." };
    }
  }

  async function reconcile(
    amexLineId: string,
    receiptId: string | null,
    matchStatus: string,
  ) {
    setBusy(amexLineId);
    setError(null);
    setBulkResult(null);
    const result = await reconcileFetch(amexLineId, receiptId, matchStatus);
    if (!result.ok) {
      setError(result.error ?? "Failed.");
    } else {
      router.refresh();
    }
    setBusy(null);
  }

  async function bulkConfirm() {
    const matches = autoMatches.filter((m) => m.confidenceScore >= confidenceThreshold);
    if (matches.length === 0) return;

    setBulkProgress({ current: 0, total: matches.length });
    setBulkResult(null);
    setError(null);

    let confirmed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      setBulkProgress({ current: i + 1, total: matches.length });

      const result = await reconcileFetch(match.amexLineId, match.receiptId, "confirmed");
      if (result.ok) {
        confirmed++;
      } else {
        failed++;
        errors.push(`Line ${match.amexLineId}: ${result.error}`);
      }
    }

    setBulkProgress(null);
    setBulkResult({ confirmed, failed, errors });
    router.refresh();
  }

  async function updateCategory(lineId: string, expenseCategoryCode: string) {
    setCategoryBusy(lineId);
    setError(null);
    try {
      const res = await fetch(`/api/receipts/amex/lines/${lineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expenseCategoryCode }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? "Could not save category.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error while saving category.");
    } finally {
      setCategoryBusy(null);
    }
  }

  async function updateReceiptStatus(lineId: string, receiptStatus: string, reason?: string) {
    setError(null);
    try {
      const res = await fetch(`/api/receipts/amex/lines/${lineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptStatus, receiptMissingReason: reason ?? null }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? "Could not save receipt status.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error while saving receipt status.");
    }
  }

  async function signoff() {
    setSignoffBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/receipts/reconcile/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const json = (await res.json()) as { error?: string; blockers?: string[] };
      if (!res.ok) {
        if (json.blockers && json.blockers.length > 0) {
          setError(`${json.error ?? "Blocked"}: ${json.blockers.join("; ")}`);
        } else {
          setError(json.error ?? "Sign-off failed.");
        }
        return;
      }
      router.refresh();
    } catch {
      setError("Network error during sign-off.");
    } finally {
      setSignoffBusy(false);
    }
  }

  const unmatched = amexLines.filter(
    (l) => l.match_status === "unmatched" || l.match_status === "matched",
  );
  const confirmedLines = amexLines.filter((l) => l.match_status === "confirmed");
  const noReceipt = amexLines.filter((l) => l.match_status === "no_receipt");
  const highConfidenceMatches = autoMatches.filter(
    (m) => m.confidenceScore >= confidenceThreshold,
  );

  // Keyboard navigation — useEffect with proper deps, no render-time ref writes
  const unmatchedCount = unmatched.length;
  const handleKeydown = useCallback((e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if ((e.target as HTMLElement).isContentEditable) return;
    if (busy !== null || finalized) return;

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIndex((prev) =>
        unmatchedCount === 0 ? null : prev === null ? 0 : Math.min(prev + 1, unmatchedCount - 1),
      );
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex((prev) =>
        unmatchedCount === 0 ? null : prev === null ? unmatchedCount - 1 : Math.max(prev - 1, 0),
      );
    } else if (e.key === "c") {
      if (focusIndex === null) return;
      const line = unmatched[focusIndex];
      if (!line) return;
      const m = matchMap.get(line.id);
      const sr = m ? receiptMap.get(String(m.receiptId)) : null;
      if (sr) reconcile(line.id, sr.id, "confirmed");
    } else if (e.key === "n") {
      if (focusIndex === null) return;
      const line = unmatched[focusIndex];
      if (!line) return;
      reconcile(line.id, null, "no_receipt");
      updateReceiptStatus(line.id, "no_receipt_required");
    } else if (e.key === "?") {
      setShowHelp((prev) => !prev);
    }
  }, [busy, finalized, focusIndex, unmatchedCount, unmatched, matchMap, receiptMap]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [handleKeydown]);

  useEffect(() => {
    if (focusIndex === null) return;
    if (focusIndex >= unmatchedCount) {
      setFocusIndex(unmatchedCount > 0 ? unmatchedCount - 1 : null);
      return;
    }
    cardRefs.current[focusIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusIndex, unmatchedCount]);

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
    const needsAttendees = categoryRequiresAttendees(line.expense_category_code);
    const hasCategory = !!line.expense_category_code;
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={line.expense_category_code ?? ""}
          disabled={locked || categoryBusy === line.id}
          onChange={(e) => updateCategory(line.id, e.target.value)}
          className={`rounded-lg border px-2 py-1 text-xs focus:border-amber-500 focus:outline-none ${
            !hasCategory
              ? "border-amber-300 bg-amber-50 text-amber-700"
              : "border-gray-200 bg-white text-gray-700"
          }`}
        >
          <option value="">— Select category —</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c.code} value={c.code}>{formatCategoryLabel(c.code)}</option>
          ))}
        </select>
        {hasCategory && line.category_status !== "confirmed" && (
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

  // Sort orphan receipts: dateless first
  const sortedOrphanReceipts = [...orphanReceipts].sort((a, b) => {
    if (!a.transaction_date && b.transaction_date) return -1;
    if (a.transaction_date && !b.transaction_date) return 1;
    return 0;
  });

  // Receipts available in the manual selector — scoped to window
  const selectorReceipts = receiptsInWindow ?? receipts;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Finalized banner */}
      {finalized && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
          This reconciliation is signed off — edits are blocked.
        </div>
      )}

      {/* Bulk auto-confirm */}
      {!finalized && highConfidenceMatches.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <button
            disabled={locked}
            onClick={bulkConfirm}
            className="rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {bulkProgress
              ? `Confirming ${bulkProgress.current} of ${bulkProgress.total}…`
              : `Auto-confirm matches ≥ ${Math.round(confidenceThreshold * 100)}%`}
          </button>
          <select
            value={confidenceThreshold}
            onChange={(e) => {
              setConfidenceThreshold(Number(e.target.value));
              setBulkResult(null);
            }}
            disabled={locked}
            className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-xs text-gray-700 focus:border-amber-500 focus:outline-none"
          >
            <option value={0.8}>80%</option>
            <option value={0.9}>90%</option>
            <option value={0.95}>95%</option>
          </select>
          <span className="text-xs text-amber-700">
            {highConfidenceMatches.length} match{highConfidenceMatches.length !== 1 ? "es" : ""} above threshold
          </span>
        </div>
      )}

      {bulkResult && (
        <div
          className={`rounded-xl border px-3 py-2 text-sm ${
            bulkResult.failed > 0
              ? "border-amber-200 bg-amber-50 text-amber-700"
              : "border-green-200 bg-green-50 text-green-700"
          }`}
        >
          Confirmed {bulkResult.confirmed} match{bulkResult.confirmed !== 1 ? "es" : ""}.
          {bulkResult.failed > 0 && ` ${bulkResult.failed} failed.`}
          {bulkResult.errors.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs">
              {bulkResult.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Pending reconciliation */}
      {unmatched.length > 0 && (
        <div>
          <div className="mb-3 flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-700">
              Pending ({unmatched.length})
            </h3>
            {!finalized && <span className="text-xs text-gray-400">Press ? for shortcuts</span>}
          </div>
          <div className="space-y-3">
            {unmatched.map((line, i) => {
              const autoMatch = matchMap.get(line.id);
              const suggestedReceipt = autoMatch
                ? receiptMap.get(String(autoMatch.receiptId))
                : null;

              return (
                <div
                  key={line.id}
                  ref={(el) => { cardRefs.current[i] = el; }}
                  className={`rounded-2xl border bg-white p-4 shadow-sm transition-shadow ${
                    focusIndex === i ? "ring-2 ring-amber-500 border-amber-300" : "border-gray-200"
                  }`}
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
                        disabled={locked || busy === line.id}
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
                      {/* Delta badges */}
                      {(() => {
                        const badges: { key: string; label: string }[] = [];
                        const rAmt = suggestedReceipt.amount_minor ?? 0;
                        const lAmt = line.amount_minor;
                        if (rAmt !== lAmt) {
                          const diff = lAmt - rAmt;
                          const sign = diff > 0 ? "+" : "−";
                          badges.push({
                            key: "amt",
                            label: line.currency === "JPY"
                              ? `Δ ${sign}¥${Math.abs(diff).toLocaleString()}`
                              : `Δ ${sign}${(Math.abs(diff) / 100).toFixed(2)} ${line.currency}`,
                          });
                        }
                        if (line.merchant && suggestedReceipt.merchant &&
                          normalizeDescription(line.merchant) !== normalizeDescription(suggestedReceipt.merchant)) {
                          badges.push({ key: "merchant", label: "merchant differs" });
                        }
                        if (line.transaction_date && suggestedReceipt.transaction_date &&
                          line.transaction_date !== suggestedReceipt.transaction_date) {
                          const ms = Math.round(
                            (new Date(line.transaction_date).getTime() -
                              new Date(suggestedReceipt.transaction_date).getTime()) /
                              86_400_000,
                          );
                          badges.push({ key: "date", label: `Δ ${Math.abs(ms)} day${Math.abs(ms) !== 1 ? "s" : ""}` });
                        }
                        return badges.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {badges.map((b) => (
                              <span key={b.key} className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                                {b.label}
                              </span>
                            ))}
                          </div>
                        ) : null;
                      })()}
                      {line.merchant && suggestedReceipt.merchant &&
                        normalizeDescription(line.merchant) !== normalizeDescription(suggestedReceipt.merchant) && (
                        <p className="mt-1 text-xs text-amber-700">
                          Will rename receipt: {suggestedReceipt.merchant} → {line.merchant}
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          disabled={locked || busy === line.id}
                          onClick={() =>
                            reconcile(line.id, suggestedReceipt.id, "confirmed")
                          }
                          className="rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                        >
                          Confirm match
                        </button>
                        <span className="text-[10px] text-gray-400">AMEX merchant overrides receipt on confirm</span>
                        <button
                          disabled={locked || busy === line.id}
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
                      className="block w-full rounded-xl border border-gray-300 px-3 py-2 text-xs text-gray-700 focus:border-amber-500 focus:outline-none disabled:opacity-50"
                      defaultValue=""
                      disabled={locked}
                      onChange={(e) => {
                        if (e.target.value) {
                          reconcile(line.id, e.target.value, "confirmed");
                        }
                      }}
                    >
                      <option value="">— Manually link a receipt —</option>
                      {selectorReceipts
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
      {confirmedLines.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">
            Confirmed ({confirmedLines.length})
          </h3>
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full text-xs">
              <tbody className="divide-y divide-gray-100">
                {confirmedLines.map((line) => {
                  const r = line.matched_receipt_id
                    ? receiptMap.get(line.matched_receipt_id)
                    : null;
                  return (
                    <tr key={line.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-700">{line.transaction_date}</td>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {line.merchant}
                        {line.re_review_needed === 1 && (
                          <span className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                            Re-review
                          </span>
                        )}
                        {line.cardholder_name && (
                          <span className="ml-1 text-gray-400">({line.cardholder_name})</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{formatAmount(line)}</td>
                      <td className="px-4 py-3">
                        <select
                          value={line.expense_category_code ?? ""}
                          disabled={locked || categoryBusy === line.id}
                          onChange={(e) =>
                            updateCategory(line.id, e.target.value)
                          }
                          className={`rounded-lg border px-2 py-0.5 text-xs focus:border-amber-500 focus:outline-none ${
                            !line.expense_category_code
                              ? "border-amber-300 bg-amber-50 text-amber-700"
                              : "border-gray-200 text-gray-700"
                          }`}
                        >
                          <option value="">— Select —</option>
                          {EXPENSE_CATEGORIES.map((c) => (
                            <option key={c.code} value={c.code}>{formatCategoryLabel(c.code)}</option>
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
                        value={line.expense_category_code ?? ""}
                        disabled={locked || categoryBusy === line.id}
                        onChange={(e) =>
                          updateCategory(line.id, e.target.value)
                        }
                        className={`rounded-lg border px-2 py-0.5 text-xs focus:border-amber-500 focus:outline-none ${
                          !line.expense_category_code
                            ? "border-amber-300 bg-amber-50 text-amber-700"
                            : "border-gray-200 text-gray-700"
                        }`}
                      >
                        <option value="">— Select —</option>
                        {EXPENSE_CATEGORIES.map((c) => (
                          <option key={c.code} value={c.code}>{formatCategoryLabel(c.code)}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <NoReceiptReasonCell line={line} onUpdate={updateReceiptStatus} disabled={locked} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Orphan receipts */}
      {sortedOrphanReceipts.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700">
            Orphan receipts ({sortedOrphanReceipts.length})
          </h3>
          <div className="space-y-3">
            {sortedOrphanReceipts.map((r) => (
              <div
                key={r.id}
                className="rounded-2xl border border-orange-200 bg-orange-50 p-4 shadow-sm"
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm text-gray-700">{receiptLabel(r)}</p>
                  {!r.transaction_date && (
                    <span className="rounded-full bg-orange-200 px-2 py-0.5 text-xs text-orange-800">
                      no date
                    </span>
                  )}
                </div>
                {!finalized && unmatched.length > 0 && (
                  <div className="mt-2">
                    <select
                      className="block w-full rounded-xl border border-orange-300 bg-white px-3 py-2 text-xs text-gray-700 focus:border-amber-500 focus:outline-none disabled:opacity-50"
                      defaultValue=""
                      disabled={locked}
                      onChange={(e) => {
                        if (e.target.value) {
                          reconcile(e.target.value, r.id, "confirmed");
                        }
                      }}
                    >
                      <option value="">— Manually link to AMEX line —</option>
                      {unmatched.map((line) => (
                        <option key={line.id} value={line.id}>
                          {line.transaction_date} · {line.merchant} · {formatAmount(line)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {unmatched.length === 0 && confirmedLines.length === 0 && noReceipt.length === 0 && (
        <p className="text-sm text-gray-500">
          No AMEX lines found. Import a statement CSV first.
        </p>
      )}

      {/* Sign-off */}
      {!finalized && amexLines.length > 0 && (
        <div className="flex items-center gap-3">
          <button
            disabled={locked || unmatched.length > 0}
            onClick={signoff}
            className="rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              unmatched.length > 0
                ? `${unmatched.length} unresolved line(s) must be resolved before signing off`
                : "Sign off reconciliation for this month"
            }
          >
            {signoffBusy ? "Signing off…" : "Sign off reconciliation"}
          </button>
          {unmatched.length > 0 && (
            <span className="text-xs text-gray-400">
              {unmatched.length} unresolved line(s)
            </span>
          )}
        </div>
      )}
      {/* Keyboard shortcuts help */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowHelp(false)}>
          <div className="rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h4 className="mb-3 font-semibold text-gray-900">Keyboard shortcuts</h4>
            <dl className="space-y-1 text-sm">
              <div className="flex gap-4"><dt className="w-12 font-mono text-amber-600">j / ↓</dt><dd className="text-gray-700">Next card</dd></div>
              <div className="flex gap-4"><dt className="w-12 font-mono text-amber-600">k / ↑</dt><dd className="text-gray-700">Previous card</dd></div>
              <div className="flex gap-4"><dt className="w-12 font-mono text-amber-600">c</dt><dd className="text-gray-700">Confirm suggested match</dd></div>
              <div className="flex gap-4"><dt className="w-12 font-mono text-amber-600">n</dt><dd className="text-gray-700">Mark no receipt</dd></div>
              <div className="flex gap-4"><dt className="w-12 font-mono text-amber-600">?</dt><dd className="text-gray-700">Toggle this help</dd></div>
            </dl>
            <button onClick={() => setShowHelp(false)} className="mt-4 rounded-lg bg-gray-100 px-3 py-1 text-xs text-gray-600 hover:bg-gray-200">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NoReceiptReasonCell({
  line,
  onUpdate,
  disabled,
}: {
  line: AmexStatementLine;
  onUpdate: (id: string, status: string, reason?: string) => void;
  disabled?: boolean;
}) {
  const [reason, setReason] = useState(line.receipt_missing_reason ?? "");
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <span
        className={`text-gray-400 ${disabled ? "" : "hover:underline cursor-pointer"}`}
        onClick={() => { if (!disabled) setEditing(true); }}
      >
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
