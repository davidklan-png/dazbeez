"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ReceiptImageViewer } from "@/components/receipts/receipt-image-viewer";
import { Btn } from "@/components/ui/btn";
import { Pill } from "@/components/ui/pill";
import { WarningIcon, CheckIcon } from "@/components/ui/icons";
import { assessSelection, type DuplicateMemberInput } from "@/lib/receipts/duplicate-resolution-policy";

export interface ClusterMemberView {
  input: DuplicateMemberInput;
  captured_at: string;
  captured_by: string;
  source: string;
  original_content_type: string;
  original_filename: string | null;
  status: string;
  attendees: string[];
  amexClaim: { month: string; lineId: string } | null;
  exportMonths: string[];
  registrationReasons: string[];
}

interface ClusterResponse {
  recommendation: {
    retainedId: string;
    retainedReasons: string[];
    conflicts: Array<{ field: string; values: Array<{ id: string; value: string | number | null }> }>;
    requiredTransfers: Array<{ fromId: string; fields: string[] }>;
    blockReasons: string[];
    assessments: Array<{
      id: string;
      tier: "protected" | "registered" | "unregistered";
      canPurge: boolean;
      completenessScore: number;
      completedFields: string[];
      missingFields: string[];
      isRetained: boolean;
    }>;
  };
  members: ClusterMemberView[];
}

export function DuplicateResolutionModal({
  clusterIds,
  onClose,
}: {
  clusterIds: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<ClusterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retainedId, setRetainedId] = useState<string | null>(null);
  // Explicit purge-target selection. EMPTY BY DEFAULT (correction §1). The
  // recommendation is advisory only; nothing is purged unless checked.
  const [purgeSelected, setPurgeSelected] = useState<Set<string>>(new Set());
  const [visualConfirmed, setVisualConfirmed] = useState(false);
  const [legalAck, setLegalAck] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [partialWarning, setPartialWarning] = useState<
    Array<{ purgeJobId: string; receiptId: string; error: string | null }> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        // §7: encode query using URLSearchParams (not manual string concat).
        const params = new URLSearchParams({ ids: clusterIds.join(",") });
        const res = await fetch(`/api/receipts/duplicates/cluster?${params}`);
        const json = (await res.json().catch(() => ({}))) as ClusterResponse | { error?: string };
        if (!res.ok || !("members" in json)) {
          setError((json as { error?: string }).error ?? "Failed to load cluster.");
          return;
        }
        if (cancelled) return;
        setData(json);
        setRetainedId(json.recommendation.retainedId);
        setPurgeSelected(new Set()); // none by default
      } catch {
        setError("Network error.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clusterIds]);

  const members = data?.members ?? [];

  // Changing the retained receipt clears all purge selections and recomputes the
  // preview/blockers for the operator's actual selection (correction §1/§3).
  function changeRetained(id: string) {
    setRetainedId(id);
    setPurgeSelected(new Set());
    setConfirmText("");
  }
  function togglePurge(id: string) {
    setPurgeSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmText("");
  }

  const selectedTargetIds = useMemo(() => [...purgeSelected], [purgeSelected]);
  // Recompute per-target purgeability for the operator's selection (pure).
  const selection = useMemo(() => {
    if (!data || !retainedId) return null;
    return assessSelection(
      members.map((m) => m.input),
      retainedId,
      selectedTargetIds,
    );
  }, [data, retainedId, selectedTargetIds, members]);

  const retainedRow = members.find((m) => m.input.id === retainedId) ?? null;
  const targetsPayload = selectedTargetIds.map((id) => {
    const m = members.find((x) => x.input.id === id);
    return { receiptId: id, expectedUpdatedAt: m?.input.updated_at ?? "" };
  });

  const expectedConfirm = `PURGE ${selectedTargetIds.length}`;
  const selectionBlocked = !!selection?.blocked;
  const canSubmit =
    !!retainedRow &&
    selectedTargetIds.length >= 1 &&
    !selectionBlocked &&
    visualConfirmed &&
    legalAck &&
    confirmText.trim() === expectedConfirm &&
    reason.trim().length > 0 &&
    !submitting;

  async function submitPurge() {
    if (!data || !retainedId || !retainedRow) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/receipts/duplicates/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retainedReceiptId: retainedId,
          retainedExpectedUpdatedAt: retainedRow.input.updated_at,
          targets: targetsPayload,
          visualConfirmed,
          legalHoldExceptionAcknowledged: legalAck,
          confirmationText: confirmText,
          reason,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        completed?: boolean;
        targets?: Array<{ receiptId: string; purgeJobId: string; status: string; errorText: string | null }>;
      };
      if (!res.ok) {
        setError(json.error ?? "Purge failed.");
        return;
      }
      if (json.completed) {
        router.refresh();
        onClose();
        return;
      }
      const failed = (json.targets ?? []).filter((t) => t.status === "storage_failed");
      setPartialWarning(
        failed.map((t) => ({ purgeJobId: t.purgeJobId, receiptId: t.receiptId, error: t.errorText })),
      );
      router.refresh();
    } catch {
      setError("Network error.");
    } finally {
      setSubmitting(false);
    }
  }

  async function retryJob(purgeJobId: string) {
    setError(null);
    try {
      const res = await fetch("/api/receipts/duplicates/purge/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purgeJobId }),
      });
      const json = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (!res.ok) {
        setError(json.error ?? "Retry failed.");
        return;
      }
      if (json.status === "completed") {
        setPartialWarning((prev) => (prev ?? []).filter((p) => p.purgeJobId !== purgeJobId));
      }
    } catch {
      setError("Network error.");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 p-4">
      <div className={`my-6 w-full rounded-2xl bg-white shadow-xl ${members.length >= 3 ? "max-w-7xl" : "max-w-6xl"}`}>
        <div className="flex items-center justify-between border-b border-gray-150 px-6 py-4">
          <div>
            <div className="text-base font-bold text-gray-900">Resolve possible duplicate</div>
            <div className="text-xs text-gray-500">
              Compare documents, keep the canonical receipt, then explicitly check each duplicate to purge.
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-gray-500 hover:bg-gray-100">
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] overflow-auto px-6 py-4">
          {loading && <div className="py-10 text-center text-sm text-gray-500">Loading comparison…</div>}
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          {partialWarning && partialWarning.length > 0 && (
            <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <div className="font-semibold">
                Receipt purged, but R2 storage cleanup is incomplete for {partialWarning.length} target(s).
              </div>
              <ul className="mt-1 list-disc pl-5">
                {partialWarning.map((p) => (
                  <li key={p.purgeJobId}>
                    {p.receiptId.slice(0, 8)}: {p.error}{" "}
                    <button type="button" onClick={() => retryJob(p.purgeJobId)} className="font-semibold underline">
                      Retry cleanup
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data && !loading && (
            <>
              {data.recommendation.conflicts.length > 0 && (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <span className="font-semibold">Conflicting values — compare the documents:</span>{" "}
                  {data.recommendation.conflicts
                    .map((c) => `${c.field} (${c.values.map((v) => String(v.value)).join(" vs ")})`)
                    .join("; ")}
                </div>
              )}

              {/* §8: three-column for 3+ member clusters at desktop; two for pairs. */}
              <div className={`grid grid-cols-1 gap-4 ${members.length >= 3 ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
                {members.map((m) => {
                  const a = data.recommendation.assessments.find((x) => x.id === m.input.id)!;
                  const isRetained = m.input.id === retainedId;
                  const isPurgeSelected = purgeSelected.has(m.input.id);
                  const selTarget = selection?.perTarget.find((t) => t.id === m.input.id);
                  return (
                    <div
                      key={m.input.id}
                      className={[
                        "rounded-xl border p-4",
                        isRetained ? "border-amber-500 ring-1 ring-amber-500" : "border-gray-200",
                      ].join(" ")}
                    >
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <label className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                          <input type="radio" name="retained" checked={isRetained} onChange={() => changeRetained(m.input.id)} />
                          Keep (canonical)
                        </label>
                        <div className="flex flex-wrap justify-end gap-1">
                          {a.isRetained && data.recommendation.retainedReasons.map((r) => (
                            <Pill key={r} tone="green" size="sm">{r}</Pill>
                          ))}
                          {m.registrationReasons.map((r) => (
                            <Pill key={r} tone={a.tier === "protected" ? "gray" : "blue"} size="sm">{r}</Pill>
                          ))}
                          <Pill tone="gray" size="sm">completeness {a.completenessScore}/10</Pill>
                        </div>
                      </div>

                      <div className="mb-3">
                        <ReceiptImageViewer receiptId={m.input.id} contentType={m.original_content_type} />
                      </div>

                      <div className="space-y-1 text-xs text-gray-700">
                        <Row k="Merchant" v={m.input.merchant ?? "—"} />
                        <Row k="Date" v={m.input.transaction_date ?? "(no date)"} />
                        <Row k="Amount" v={`${m.input.currency} ${m.input.amount_minor ?? "—"}`} />
                        <Row k="Category" v={m.input.expense_category_code ?? "—"} />
                        <Row k="Purpose" v={m.input.business_purpose ?? "—"} />
                        <Row k="Tax" v={m.input.tax_amount_minor != null ? String(m.input.tax_amount_minor) : m.input.tax_rate ?? "—"} />
                        <Row k="Invoice no." v={m.input.invoice_registration_number ?? "—"} />
                        <Row k="Counterparty" v={m.input.counterparty_name ?? "—"} />
                        <Row k="Attendees" v={m.attendees.length ? m.attendees.join(", ") : "—"} />
                        <Row k="Captured" v={`${m.source} · ${m.captured_by} · ${m.captured_at.slice(0, 10)}`} />
                        <Row k="AMEX claim" v={m.amexClaim ? `${m.amexClaim.month} · ${m.amexClaim.lineId.slice(0, 8)}` : "—"} />
                        <Row k="Export" v={m.exportMonths.length ? m.exportMonths.join(", ") : "—"} />
                        {a.missingFields.length > 0 && <div className="pt-1 text-gray-400">Missing: {a.missingFields.join(", ")}</div>}
                      </div>

                      {/* Explicit purge-target checkbox (correction §1). Protected
                          members can never be checked. Unselected → untouched. */}
                      {!isRetained && (
                        <label className={`mt-2 flex items-center gap-2 text-sm ${a.canPurge ? "text-gray-900" : "text-gray-400"}`}>
                          <input
                            type="checkbox"
                            checked={isPurgeSelected}
                            disabled={!a.canPurge}
                            onChange={() => togglePurge(m.input.id)}
                          />
                          Purge this duplicate
                          {!a.canPurge && <span className="text-[11px]">(protected — cannot purge)</span>}
                          {isPurgeSelected && selTarget && !selTarget.purgeable && (
                            <span className="text-[11px] text-red-600">{selTarget.blockers.join(" ")}</span>
                          )}
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {data && !loading && (
          <div className="border-t border-gray-150 bg-gray-50 px-6 py-4">
            {selectionBlocked && (
              <div className="mb-2 text-xs text-red-700">
                {selection?.blockReasons.join(" | ")}
              </div>
            )}
            <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-gray-700">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={visualConfirmed} onChange={(e) => setVisualConfirmed(e.target.checked)} />
                I visually confirmed the checked files represent the same receipt/charge.
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={legalAck} onChange={(e) => setLegalAck(e.target.checked)} />
                I acknowledge this is the narrow duplicate exception to receipt retention / legal hold.
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={`Type exactly: ${expectedConfirm}`}
                className="h-9 w-56 rounded-lg border border-gray-300 px-2 font-mono text-sm"
              />
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason (required)"
                className="h-9 flex-1 rounded-lg border border-gray-300 px-2 text-sm"
              />
              <Btn kind="danger" size="md" onClick={submitPurge} disabled={!canSubmit} leftIcon={<CheckIcon size={14} className="text-white" />}>
                {submitting ? "Purging…" : "Purge duplicate permanently"}
              </Btn>
            </div>
            <div className="mt-1 text-[11px] text-gray-400">
              Permanent: removes D1 + R2. Only checked targets are purged:{" "}
              {selectedTargetIds.map((id) => id.slice(0, 8)).join(", ") || "(none checked)"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-gray-400">{k}</span>
      <span className="min-w-0 flex-1 break-words">{v}</span>
    </div>
  );
}
