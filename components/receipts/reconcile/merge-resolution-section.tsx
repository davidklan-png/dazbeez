"use client";

import { useMemo, useState } from "react";
import { Btn } from "@/components/ui/btn";
import { Pill } from "@/components/ui/pill";
import { EXPENSE_CATEGORIES, formatCategoryLabel } from "@/lib/receipts/categories";
import type { ClusterMemberView } from "./duplicate-resolution-modal";
import type { SelectionAssessment } from "@/lib/receipts/duplicate-resolution-policy";

type ResAction = "copy_from_source" | "manual_value";
interface FieldRes { action: ResAction; manualValue?: string; sourceId: string }

const FIELD_LABELS: Record<string, string> = {
  transaction_date: "Transaction date",
  merchant: "Merchant",
  amount: "Amount",
  category: "Expense category",
  business_purpose: "Business purpose",
  alcohol_present: "Alcohol present",
  tax_amount: "Consumption tax amount",
  tax_rate: "Tax rate",
  invoice_number: "Invoice registration number",
  counterparty: "Counterparty",
  attendees: "Attendees",
};

function getSourceValue(member: ClusterMemberView, field: string): string {
  const i = member.input;
  switch (field) {
    case "transaction_date": return i.transaction_date ?? "—";
    case "merchant": return i.merchant ?? "—";
    case "amount": return `${i.currency} ${i.amount_minor ?? "—"}`;
    case "category": return i.expense_category_code ?? "—";
    case "business_purpose": return i.business_purpose ?? "—";
    case "alcohol_present": return i.alcoholPresent ? "Yes" : "No";
    case "tax_amount": return i.tax_amount_minor != null ? String(i.tax_amount_minor) : "—";
    case "tax_rate": return i.tax_rate ?? "—";
    case "invoice_number": return i.invoice_registration_number ?? "—";
    case "counterparty": return i.counterparty_name ?? "—";
    case "attendees": return member.attendees.join(", ") || "—";
    default: return "—";
  }
}

export function MergeResolutionSection({
  retainedId,
  retainedUpdatedAt,
  targets,
  members,
  selection,
  onMerged,
}: {
  retainedId: string;
  retainedUpdatedAt: string;
  targets: string[];
  members: ClusterMemberView[];
  selection: SelectionAssessment;
  onMerged: () => void;
}) {
  const [resolutions, setResolutions] = useState<Record<string, FieldRes>>({});
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState<string[] | null>(null);
  const [correctionRequired, setCorrectionRequired] = useState<{ month: string } | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");

  // Compute blocking target-only fields per target.
  const blockingFields = useMemo(() => {
    const result: Array<{ targetId: string; target: ClusterMemberView; fields: string[] }> = [];
    for (const targetId of targets) {
      const targetAssessment = selection.perTarget.find((t) => t.id === targetId);
      if (!targetAssessment?.missingFieldsToCopy.length) continue;
      const target = members.find((m) => m.input.id === targetId);
      if (!target) continue;
      result.push({ targetId, target, fields: targetAssessment.missingFieldsToCopy });
    }
    return result;
  }, [targets, selection, members]);

  if (blockingFields.length === 0 && !mergeSuccess) return null;

  function setRes(key: string, action: ResAction, sourceId: string, manualValue?: string) {
    setResolutions((prev) => ({ ...prev, [key]: { action, sourceId, manualValue } }));
  }

  // Check if all blocking fields have a resolution.
  const allResolved = blockingFields.every(({ targetId, fields }) =>
    fields.every((f) => resolutions[`${targetId}:${f}`]),
  );

  async function applyMerge() {
    if (!allResolved) return;
    setMergeBusy(true);
    setMergeError(null);
    setMergeSuccess(null);

    // Build the resolution plan from the UI state.
    const plan: Array<{
      field: string;
      action: "copy_from_source" | "keep_retained" | "manual_value";
      sourceReceiptId?: string;
      manualValue?: string | number | null;
    }> = [];
    const sourceIds = new Set<string>();
    for (const { targetId, fields } of blockingFields) {
      sourceIds.add(targetId);
      for (const field of fields) {
        const key = `${targetId}:${field}`;
        const res = resolutions[key];
        if (!res) continue;
        plan.push({
          field,
          action: res.action,
          sourceReceiptId: res.action === "copy_from_source" ? res.sourceId : undefined,
          manualValue: res.action === "manual_value" ? res.manualValue : undefined,
        });
      }
    }

    try {
      const res = await fetch("/api/receipts/duplicates/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retainedReceiptId: retainedId,
          retainedExpectedUpdatedAt: retainedUpdatedAt,
          sources: [...sourceIds].map((id) => {
            const m = members.find((x) => x.input.id === id);
            return { receiptId: id, expectedUpdatedAt: m?.input.updated_at ?? "" };
          }),
          resolutionPlan: plan,
          correctionReason: correctionReason.trim() || undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        month?: string;
        updatedFields?: string[];
      };
      if (!res.ok) {
        if (json.code === "CORRECTION_DRAFT_REQUIRED") {
          setCorrectionRequired({ month: json.month ?? "unknown" });
          setMergeError(json.error ?? "A correction draft is required.");
        } else {
          setMergeError(json.error ?? "Merge failed.");
        }
        return;
      }
      // Success — reset and notify parent to reload.
      setMergeSuccess(json.updatedFields ?? []);
      setCorrectionRequired(null);
      setResolutions({});
      onMerged();
    } catch {
      setMergeError("Network error.");
    } finally {
      setMergeBusy(false);
    }
  }

  async function createCorrectionDraft() {
    if (!correctionRequired || !correctionReason.trim()) return;
    setMergeBusy(true);
    setMergeError(null);
    try {
      const res = await fetch(`/api/receipts/export/${correctionRequired.month}?correction=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correctionReason: correctionReason.trim() }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setMergeError(json.error ?? "Failed to create correction draft.");
        return;
      }
      // Draft created — retry the merge.
      setCorrectionRequired(null);
      await applyMerge();
    } catch {
      setMergeError("Network error creating correction draft.");
    } finally {
      setMergeBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-bold text-amber-900">⚠ Prepare retained receipt</span>
        <span className="text-xs text-amber-700">
          Target-only accounting data must be resolved before purge. Copy or enter values; the server revalidates.
        </span>
      </div>

      {mergeError && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {mergeError}
        </div>
      )}

      {mergeSuccess && (
        <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">
          ✓ Applied {mergeSuccess.length} field(s): {mergeSuccess.join(", ")}. Comparison reloaded —
          reselect purge targets below.
        </div>
      )}

      {correctionRequired && (
        <div className="mb-3 rounded-lg border border-amber-400 bg-amber-100 px-3 py-3 text-xs text-amber-900">
          <div className="font-semibold">
            The retained receipt is in finalized export {correctionRequired.month}. A correction draft is required.
          </div>
          <div className="mt-1">
            Reason:{" "}
            <input
              value={correctionReason}
              onChange={(e) => setCorrectionReason(e.target.value)}
              placeholder="Why is this correction needed?"
              className="h-8 w-64 rounded border border-amber-300 px-2 text-xs"
            />
          </div>
          <Btn
            kind="primary"
            size="sm"
            onClick={createCorrectionDraft}
            disabled={!correctionReason.trim() || mergeBusy}
            className="mt-2"
          >
            Create correction draft and apply
          </Btn>
        </div>
      )}

      {/* Per-target blocking fields with resolution controls */}
      {blockingFields.map(({ targetId, target, fields }) => (
        <div key={targetId} className="mb-3 rounded-lg border border-amber-200 bg-white p-3">
          <div className="mb-2 text-xs font-semibold text-gray-700">
            From {target.input.merchant ?? targetId.slice(0, 8)} ({targetId.slice(0, 8)}):
          </div>
          {fields.map((field) => {
            const key = `${targetId}:${field}`;
            const res = resolutions[key];
            const sourceVal = getSourceValue(target, field);
            return (
              <div key={field} className="mb-2 flex items-start gap-3 text-xs">
                <div className="w-40 shrink-0 font-medium text-gray-600">
                  {FIELD_LABELS[field] ?? field}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-gray-400">Source: </span>
                  <span className="font-mono text-gray-700">{sourceVal}</span>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name={key}
                        checked={res?.action === "copy_from_source"}
                        onChange={() => setRes(key, "copy_from_source", targetId)}
                      />
                      Copy to retained
                    </label>
                    <label className="flex items-center gap-1">
                      <input
                        type="radio"
                        name={key}
                        checked={res?.action === "manual_value"}
                        onChange={() => setRes(key, "manual_value", targetId, getSourceValue(target, field))}
                      />
                      Enter corrected value
                    </label>
                    {res?.action === "manual_value" && (
                      <input
                        value={res.manualValue ?? ""}
                        onChange={(e) => setRes(key, "manual_value", targetId, e.target.value)}
                        className="h-7 w-40 rounded border border-gray-200 px-2 text-xs"
                        placeholder="Corrected value"
                      />
                    )}
                    {field === "category" && res?.action === "manual_value" && (
                      <select
                        value={res.manualValue ?? ""}
                        onChange={(e) => setRes(key, "manual_value", targetId, e.target.value)}
                        className="h-7 rounded border border-gray-200 px-1 text-xs"
                      >
                        <option value="">— Select —</option>
                        {EXPENSE_CATEGORIES.map((c) => (
                          <option key={c.code} value={c.code}>{formatCategoryLabel(c.code)}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {blockingFields.length > 0 && (
        <Btn
          kind="primary"
          size="sm"
          onClick={applyMerge}
          disabled={!allResolved || mergeBusy || !!correctionRequired}
        >
          {mergeBusy ? "Applying…" : "Apply changes to retained receipt"}
        </Btn>
      )}
      {!allResolved && blockingFields.length > 0 && (
        <span className="ml-2 text-xs text-amber-700">
          Resolve all fields above before applying.
        </span>
      )}
    </div>
  );
}
