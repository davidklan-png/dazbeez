"use client";

import { useMemo, useState } from "react";
import { Btn } from "@/components/ui/btn";
import { EXPENSE_CATEGORIES, formatCategoryLabel } from "@/lib/receipts/categories";
import type {
  DuplicateMergeApiResult,
  FieldResolution,
  ResolutionAction,
} from "@/lib/receipts/duplicate-merge-contract";
import {
  buildResolutionNeeds,
  FIELD_LABELS,
  type ResolutionNeed,
} from "@/lib/receipts/duplicate-merge-ui";
import { ALLOWED_CURRENCIES } from "@/lib/receipts/validation";
import type { ClusterMemberView } from "./duplicate-resolution-modal";

interface DraftResolution {
  action: ResolutionAction;
  sourceIds: string[];
  manualText: string;
  manualCurrency: string;
  manualBoolean: boolean;
}

const EMPTY_DRAFT: DraftResolution = {
  action: "copy_from_source",
  sourceIds: [],
  manualText: "",
  manualCurrency: "JPY",
  manualBoolean: true,
};

function manualValue(need: ResolutionNeed, draft: DraftResolution): unknown {
  switch (need.field) {
    case "amount": return { amountMinor: Number(draft.manualText), currency: draft.manualCurrency };
    case "tax_amount": return Number(draft.manualText);
    case "alcohol_present": return draft.manualBoolean;
    case "attendees": return {
      attendees: draft.manualText.split("\n").map((name) => name.trim()).filter(Boolean)
        .map((attendeeName) => ({ attendeeName })),
    };
    default: return draft.manualText;
  }
}

function manualComplete(need: ResolutionNeed, draft: DraftResolution): boolean {
  if (need.field === "alcohol_present") return true;
  if (!draft.manualText.trim()) return false;
  if (need.field === "amount" || need.field === "tax_amount") {
    return Number.isInteger(Number(draft.manualText)) && Number(draft.manualText) >= 0;
  }
  return true;
}

export function MergeResolutionSection({
  retainedId,
  retainedUpdatedAt,
  targets,
  members,
  onMerged,
}: {
  retainedId: string;
  retainedUpdatedAt: string;
  targets: string[];
  members: ClusterMemberView[];
  onMerged: (result: DuplicateMergeApiResult) => Promise<void>;
}) {
  const needs = useMemo(
    () => buildResolutionNeeds(members.map((member) => member.input), retainedId, targets),
    [members, retainedId, targets],
  );
  const [drafts, setDrafts] = useState<Record<string, DraftResolution>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correctionRequired, setCorrectionRequired] = useState<string | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");

  if (needs.length === 0) return null;

  function update(field: string, patch: Partial<DraftResolution>) {
    setDrafts((previous) => ({
      ...previous,
      [field]: { ...EMPTY_DRAFT, ...previous[field], ...patch },
    }));
  }

  function usable(need: ResolutionNeed): boolean {
    const draft = drafts[need.field];
    if (!draft) return !need.required;
    if (draft.action === "keep_retained") return need.kind === "conflict";
    if (draft.action === "copy_from_source") return draft.sourceIds.length > 0;
    return manualComplete(need, draft);
  }

  function buildPlan(): FieldResolution[] {
    return needs.flatMap((need) => {
      const draft = drafts[need.field];
      if (!draft) return [];
      return [{
        field: need.field,
        action: draft.action,
        sourceReceiptIds: draft.action === "copy_from_source" ? draft.sourceIds : undefined,
        manualValue: draft.action === "manual_value" ? manualValue(need, draft) : undefined,
      }];
    });
  }

  async function submitPlan(): Promise<boolean> {
    const response = await fetch("/api/receipts/duplicates/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        retainedReceiptId: retainedId,
        retainedExpectedUpdatedAt: retainedUpdatedAt,
        sources: targets.map((receiptId) => ({
          receiptId,
          expectedUpdatedAt: members.find((member) => member.input.id === receiptId)?.input.updated_at ?? "",
        })),
        resolutionPlan: buildPlan(),
      }),
    });
    const json = (await response.json().catch(() => ({}))) as DuplicateMergeApiResult & {
      error?: string;
      code?: string;
      month?: string;
    };
    if (!response.ok) {
      if (json.code === "CORRECTION_DRAFT_REQUIRED") setCorrectionRequired(json.month ?? "unknown");
      setError(json.error ?? "Merge failed.");
      return false;
    }
    setCorrectionRequired(null);
    setDrafts({});
    await onMerged(json);
    return true;
  }

  async function applyMerge() {
    if (!needs.filter((need) => need.required).every(usable) || buildPlan().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await submitPlan();
    } catch {
      setError("Network error while applying the merge.");
    } finally {
      setBusy(false);
    }
  }

  async function createCorrectionAndRetry() {
    if (!correctionRequired || !correctionReason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/receipts/export/${correctionRequired}?correction=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correctionReason: correctionReason.trim() }),
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? "Failed to create correction draft.");
        return;
      }
      setCorrectionRequired(null);
      await submitPlan();
    } catch {
      setError("Network error creating the correction draft.");
    } finally {
      setBusy(false);
    }
  }

  const requiredReady = needs.filter((need) => need.required).every(usable);

  return (
    <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="font-bold text-amber-950">Prepare the retained receipt</div>
      <p className="mt-1 text-xs text-amber-800">
        Required rows preserve data that would otherwise be purged. Conflicts are optional, but can be resolved here before deletion.
      </p>

      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      {correctionRequired && (
        <div className="mt-3 rounded-lg border border-amber-400 bg-white p-3 text-xs text-amber-950">
          <div className="font-semibold">Month {correctionRequired} is sealed. Open a correction draft to apply this merge.</div>
          <input
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value)}
            placeholder="Correction reason (required)"
            className="mt-2 h-9 w-full rounded-lg border border-amber-300 px-2"
          />
          <Btn kind="primary" size="sm" className="mt-2" disabled={busy || !correctionReason.trim()} onClick={createCorrectionAndRetry}>
            Open correction draft and apply merge
          </Btn>
        </div>
      )}

      <div className="mt-3 space-y-3">
        {needs.map((need) => {
          const draft = drafts[need.field];
          const firstSource = need.sources[0]?.receiptId;
          return (
            <div key={need.field} className="rounded-lg border border-amber-200 bg-white p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{FIELD_LABELS[need.field]}</span>
                <span className={`rounded-full px-2 py-0.5 ${need.required ? "bg-red-100 text-red-700" : "bg-blue-100 text-blue-700"}`}>
                  {need.required ? "Required preservation" : "Conflict"}
                </span>
                <span className="text-gray-500">Retained: {need.retainedValue}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name={`action-${need.field}`}
                    checked={draft?.action === "copy_from_source"}
                    onChange={() => update(need.field, {
                      action: "copy_from_source",
                      sourceIds: need.field === "attendees" ? need.sources.map((source) => source.receiptId) : firstSource ? [firstSource] : [],
                    })}
                  />
                  Copy from receipt
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name={`action-${need.field}`}
                    checked={draft?.action === "manual_value"}
                    onChange={() => update(need.field, { action: "manual_value", sourceIds: [] })}
                  />
                  Enter corrected value
                </label>
                {need.kind === "conflict" && (
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`action-${need.field}`}
                      checked={draft?.action === "keep_retained"}
                      onChange={() => update(need.field, { action: "keep_retained", sourceIds: [] })}
                    />
                    Keep retained value
                  </label>
                )}
              </div>

              {draft?.action === "copy_from_source" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {need.sources.map((source) => {
                    const checked = draft.sourceIds.includes(source.receiptId);
                    return (
                      <label key={source.receiptId} className="flex items-center gap-1 rounded border border-gray-200 px-2 py-1">
                        <input
                          type={need.field === "attendees" ? "checkbox" : "radio"}
                          name={`source-${need.field}`}
                          checked={checked}
                          onChange={() => update(need.field, {
                            sourceIds: need.field === "attendees"
                              ? checked
                                ? draft.sourceIds.filter((id) => id !== source.receiptId)
                                : [...draft.sourceIds, source.receiptId]
                              : [source.receiptId],
                          })}
                        />
                        {source.receiptId.slice(0, 8)}: {source.displayValue}
                      </label>
                    );
                  })}
                </div>
              )}

              {draft?.action === "manual_value" && (
                <div className="mt-2">
                  {need.field === "category" ? (
                    <select value={draft.manualText} onChange={(event) => update(need.field, { manualText: event.target.value })} className="h-9 rounded border border-gray-300 px-2">
                      <option value="">Select a category</option>
                      {EXPENSE_CATEGORIES.map((category) => <option key={category.code} value={category.code}>{formatCategoryLabel(category.code)}</option>)}
                    </select>
                  ) : need.field === "alcohol_present" ? (
                    <select value={draft.manualBoolean ? "true" : "false"} onChange={(event) => update(need.field, { manualBoolean: event.target.value === "true" })} className="h-9 rounded border border-gray-300 px-2">
                      <option value="true">Yes</option><option value="false">No</option>
                    </select>
                  ) : need.field === "attendees" ? (
                    <textarea value={draft.manualText} onChange={(event) => update(need.field, { manualText: event.target.value })} placeholder="One attendee name per line" className="h-20 w-full rounded border border-gray-300 p-2" />
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type={need.field === "transaction_date" ? "date" : need.field === "amount" || need.field === "tax_amount" ? "number" : "text"}
                        min={need.field === "amount" || need.field === "tax_amount" ? 0 : undefined}
                        step={need.field === "amount" || need.field === "tax_amount" ? 1 : undefined}
                        value={draft.manualText}
                        onChange={(event) => update(need.field, { manualText: event.target.value })}
                        className="h-9 min-w-64 rounded border border-gray-300 px-2"
                      />
                      {need.field === "amount" && (
                        <select value={draft.manualCurrency} onChange={(event) => update(need.field, { manualCurrency: event.target.value })} className="h-9 rounded border border-gray-300 px-2">
                          {ALLOWED_CURRENCIES.map((currency) => <option key={currency}>{currency}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Btn kind="primary" size="sm" onClick={applyMerge} disabled={busy || !requiredReady || buildPlan().length === 0 || Boolean(correctionRequired)}>
          {busy ? "Applying…" : "Apply merge to retained receipt"}
        </Btn>
        {!requiredReady && <span className="text-xs text-amber-800">Resolve every required preservation row.</span>}
      </div>
    </div>
  );
}
