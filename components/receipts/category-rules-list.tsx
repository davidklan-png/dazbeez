"use client";

import { useState } from "react";
import { useToast } from "@/components/ui/toaster";
import { getCategoryByCode } from "@/lib/receipts/categories";
import type {
  MerchantCategoryRuleRow,
  CategoryProposal,
  CategoryMatchType,
} from "@/lib/receipts/category-rules";

const API = "/api/receipts/settings/category-rules";

function catName(code: string): string {
  return getCategoryByCode(code)?.jaName ?? code;
}
function matchLabel(mt: CategoryMatchType): string {
  return mt === "sender" ? "Sender" : "Merchant";
}
function formatYen(minor: number | null): string {
  return minor == null ? "—" : `¥${minor.toLocaleString()}`;
}
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
function sourceCount(row: MerchantCategoryRuleRow): number {
  if (!row.source_receipt_ids_json) return 0;
  try {
    const arr = JSON.parse(row.source_receipt_ids_json);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Client list for the Category rules Settings page. Two sections: active rules
 * (remove) and computed proposals (accept/dismiss). Every action re-fetches the
 * authoritative { rules, proposals } snapshot from the API response.
 */
export function CategoryRulesList({
  initial,
}: {
  initial: { rules: MerchantCategoryRuleRow[]; proposals: CategoryProposal[] };
}) {
  const [rules, setRules] = useState(initial.rules);
  const [proposals, setProposals] = useState(initial.proposals);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();

  async function applyResponse(res: Response): Promise<boolean> {
    const data = (await res.json().catch(() => ({}))) as {
      rules?: MerchantCategoryRuleRow[];
      proposals?: CategoryProposal[];
      error?: string;
    };
    if (!res.ok) {
      throw new Error(data.error ?? `Failed (HTTP ${res.status})`);
    }
    setRules(data.rules ?? []);
    setProposals(data.proposals ?? []);
    return true;
  }

  async function accept(p: CategoryProposal) {
    setBusy(`accept-${p.matchType}-${p.matchValue}-${p.expenseCategoryCode}`);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchType: p.matchType,
          matchValue: p.matchValue,
          expenseCategoryCode: p.expenseCategoryCode,
          sourceReceiptIds: p.sourceReceiptIds,
        }),
      });
      await applyResponse(res);
      toast({ tone: "success", title: "Rule accepted", body: `${matchLabel(p.matchType)} ${p.matchValue} → ${catName(p.expenseCategoryCode)}` });
    } catch (e) {
      toast({ tone: "error", title: "Accept failed", body: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(p: CategoryProposal) {
    setBusy(`dismiss-${p.matchType}-${p.matchValue}-${p.expenseCategoryCode}`);
    try {
      const res = await fetch(`${API}?action=dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchType: p.matchType,
          matchValue: p.matchValue,
          expenseCategoryCode: p.expenseCategoryCode,
        }),
      });
      await applyResponse(res);
      toast({ tone: "info", title: "Proposal dismissed" });
    } catch (e) {
      toast({ tone: "error", title: "Dismiss failed", body: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  async function removeRule(row: MerchantCategoryRuleRow) {
    if (!confirm(`Remove the rule for ${matchLabel(row.match_type)} "${row.match_value}"? Future matching receipts won't get the suggestion. Past receipts are untouched.`)) {
      return;
    }
    setBusy(`remove-${row.id}`);
    try {
      const res = await fetch(API, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id }),
      });
      await applyResponse(res);
      toast({ tone: "success", title: "Rule removed" });
    } catch (e) {
      toast({ tone: "error", title: "Remove failed", body: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Active rules */}
      <section>
        <h2 className="text-sm font-semibold text-gray-900">Active rules</h2>
        <p className="mt-1 text-xs text-gray-500">
          Receipts matching these get a category suggestion during review (you still click to apply).
        </p>
        {rules.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
            No active rules yet. Accept a proposal below, or categorize a few receipts from the same sender/merchant to generate one.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    <span className="mr-2 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600">
                      {matchLabel(r.match_type)}
                    </span>
                    {r.match_value}
                    <span className="mx-2 text-gray-300">→</span>
                    <span className="text-amber-700">{catName(r.expense_category_code)}</span>
                  </p>
                  <p className="mt-1 text-xs text-gray-500">
                    Accepted by {r.accepted_by} · {formatDate(r.accepted_at)} · {sourceCount(r)} source receipt{sourceCount(r) === 1 ? "" : "s"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeRule(r)}
                  disabled={busy === `remove-${r.id}`}
                  className="self-start rounded-xl border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
                >
                  {busy === `remove-${r.id}` ? "Removing…" : "Remove"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Proposed rules */}
      <section>
        <h2 className="text-sm font-semibold text-gray-900">Proposed rules</h2>
        <p className="mt-1 text-xs text-gray-500">
          Senders/merchants with ≥3 receipts sharing a category. Accept to make it a rule, or dismiss to hide it.
        </p>
        {proposals.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
            No proposals right now.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {proposals.map((p) => {
              const key = `${p.matchType}-${p.matchValue}-${p.expenseCategoryCode}`;
              return (
                <li key={key} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900">
                        <span className="mr-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                          {matchLabel(p.matchType)} · {p.count}×
                        </span>
                        {p.matchValue}
                        <span className="mx-2 text-gray-300">→</span>
                        <span className="text-amber-700">{catName(p.expenseCategoryCode)}</span>
                      </p>
                      <ul className="mt-2 space-y-0.5">
                        {p.examples.map((ex) => (
                          <li key={ex.id} className="text-xs text-gray-500">
                            {ex.merchant ?? "—"} · {formatDate(ex.transactionDate)} · {formatYen(ex.amountMinor)}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex flex-none gap-2">
                      <button
                        type="button"
                        onClick={() => accept(p)}
                        disabled={(busy ?? "").startsWith("accept-") || busy === `dismiss-${key}`}
                        className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy === `accept-${key}` ? "Accepting…" : "Accept"}
                      </button>
                      <button
                        type="button"
                        onClick={() => dismiss(p)}
                        disabled={(busy ?? "").startsWith("dismiss-") || busy === `accept-${key}`}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy === `dismiss-${key}` ? "Dismissing…" : "Dismiss"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
