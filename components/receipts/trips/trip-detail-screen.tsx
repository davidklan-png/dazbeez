"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SaveQueue } from "@/lib/receipts/save-queue";
import { registerSaveFlusher, guardedNavigate } from "@/lib/receipts/review-navigation";
import { Btn } from "@/components/ui/btn";
import { Pill } from "@/components/ui/pill";
import { Card } from "@/components/ui/card";
import { Field, TextInput } from "@/components/ui/field";
import { formatDate, formatAmountMinor, formatPaymentPath } from "@/lib/receipts/format";
import {
  tripStatusTone,
  candidateDisableReason,
  type CandidateRow,
} from "@/lib/receipts/business-trips";
import type { BusinessTripReport } from "@/lib/receipts/types";
import type {
  BusinessTripMemberLine,
  BusinessTripMemberReceipt,
} from "@/lib/receipts/db";

interface TripDetailScreenProps {
  trip: BusinessTripReport;
  lines: BusinessTripMemberLine[];
  receipts: BusinessTripMemberReceipt[];
}

interface MemberRow {
  kind: "line" | "receipt";
  id: string;
  date: string | null;
  merchant: string | null;
  amountMinor: number | null;
  month: string | null;
  status: string | null;
  sealed: boolean;
  paymentPath: string | null;
}

export function TripDetailScreen({ trip, lines, receipts }: TripDetailScreenProps) {
  const router = useRouter();

  const composing = useRef(false);
  const actionInFlight = useRef(false);
  const lineTokens = useRef(Object.fromEntries(lines.map(l => [l.id, l.revision])));
  const selectedTokens = useRef<Record<string, number>>({});
  // Editable fields (local state; Save PATCHes).
  const [fields, setFields] = useState({
    tripName: trip.trip_name ?? "",
    startDate: trip.start_date,
    endDate: trip.end_date,
    purpose: trip.purpose ?? "",
    primaryLocation: trip.primary_location ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [fieldSaved, setFieldSaved] = useState(false);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const latestFields = useRef(fields);
  latestFields.current = fields;
  const baseline = useRef({ ...fields });
  const queue = useRef<SaveQueue | null>(null);
  const config = {
    url: `/api/receipts/trips/${trip.id}`, revision: trip.revision, entity: "trip",
    deferFire: () => composing.current,
    buildBody: () => {
      const changed = Object.fromEntries(Object.entries(latestFields.current).filter(([k, v]) => v !== baseline.current[k as keyof typeof fields]));
      if ("startDate" in changed || "endDate" in changed) {
        changed.startDate = latestFields.current.startDate; changed.endDate = latestFields.current.endDate;
      }
      return changed;
    },
    onAcknowledged: (body: Record<string, unknown>, ack: { lineRevisions?: Record<string, number> }) => {
      for (const k of Object.keys(baseline.current) as (keyof typeof fields)[]) if (k in body) baseline.current[k] = body[k] as string;
      if (ack.lineRevisions) Object.assign(lineTokens.current, ack.lineRevisions);
    },
  };
  if (!queue.current) queue.current = new SaveQueue(config); else queue.current.rebind(config);
  const dirty = () => JSON.stringify(latestFields.current) !== JSON.stringify(baseline.current);
  const flushFields = async () => {
    do {
      if (dirty()) await queue.current!.save();
      await queue.current!.whenIdle();
    } while (dirty());
  };
  const flushRef = useRef(flushFields);
  flushRef.current = flushFields;
  useEffect(() => registerSaveFlusher(async () => {
    try { await flushRef.current(); } catch (err) { setFieldError(err instanceof Error ? err.message : "Reload to review."); throw err; }
  }), []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(latestFields.current) !== JSON.stringify(baseline.current) || !queue.current!.idle || queue.current!.halted) {
        e.preventDefault(); e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // Candidates picker.
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [candLoading, setCandLoading] = useState(false);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attachError, setAttachError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const memberRows: MemberRow[] = [
    ...lines.map((l) => ({
      kind: "line" as const,
      id: l.id,
      date: l.transaction_date,
      merchant: l.merchant,
      amountMinor: l.amount_minor,
      month: l.statement_month,
      status: l.business_trip_status,
      sealed: false,
      paymentPath: null,
    })),
    ...receipts.map((r) => ({
      kind: "receipt" as const,
      id: r.id,
      date: r.transaction_date,
      merchant: r.merchant,
      amountMinor: r.amount_minor,
      month: r.transaction_date ? r.transaction_date.slice(0, 7) : null,
      status: r.status,
      sealed: r.status === "exported" || r.status === "archived",
      paymentPath: r.payment_path,
    })),
  ].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  // Fetch candidates (debounced on q; refetch on showAll/refreshNonce).
  useEffect(() => {
    let cancelled = false;
    setCandLoading(true);
    const t = setTimeout(async () => {
      try {
        const url =
          `/api/receipts/trips/${trip.id}/candidates` +
          `?window=45&q=${encodeURIComponent(q)}&all=${showAll ? "true" : "false"}`;
        const res = await fetch(url);
        const data = (await res.json().catch(() => ({}))) as {
          candidates?: CandidateRow[];
        };
        if (!res.ok) throw new Error("Could not load candidates. Reload to review.");
        if (!cancelled) setCandidates(data.candidates ?? []);
      } catch (err) {
        if (!cancelled) setAttachError(err instanceof Error ? err.message : "Could not load candidates.");
      } finally {
        if (!cancelled) setCandLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, showAll, trip.id, refreshNonce]);

  async function saveFields() {
    setFieldError(null); setSaving(true);
    try { await flushFields(); setFieldSaved(true); }
    catch (err) { setFieldError(err instanceof Error ? err.message : "Outcome uncertain — reload to review."); }
    finally { setSaving(false); }
  }

  async function runAction(action: () => Promise<unknown>, onError: (message: string) => void) {
    if (actionInFlight.current) return;
    actionInFlight.current = true; setBusy(true);
    try {
      await flushFields();
      await action();
      await flushFields();
      if (!composing.current && !dirty()) router.refresh();
    } catch (err) { onError(err instanceof Error ? err.message : "Outcome uncertain — reload to review."); }
    finally { actionInFlight.current = false; setBusy(false); }
  }

  async function patchStatus(status: "confirmed" | "rejected") {
    if (status === "rejected" && !window.confirm("Reject this trip? All member AMEX lines become excluded (receipt links survive).")) return;
    setActionError(null);
    await runAction(() => queue.current!.mutate(`/api/receipts/trips/${trip.id}`, "PATCH",
      () => ({ status, expectedLines: Object.fromEntries(lines.map(l => [l.id, lineTokens.current[l.id]])) })), setActionError);
  }

  async function attach() {
    const lineIds = candidates.filter(c => c.kind === "line" && selected.has(c.id)).map(c => c.id);
    const receiptIds = candidates.filter(c => c.kind === "receipt" && selected.has(c.id)).map(c => c.id);
    if (!lineIds.length && !receiptIds.length) return;
    setAttachError(null);
    await runAction(async () => {
      await queue.current!.mutate(`/api/receipts/trips/${trip.id}/members`, "POST", () => ({ lineIds, receiptIds,
        expectedLines: Object.fromEntries(lineIds.map(id => [id, selectedTokens.current[id]])) }));
      setSelected(new Set()); setRefreshNonce(n => n + 1);
    }, setAttachError);
  }

  async function detach(row: MemberRow) {
    setActionError(null);
    await runAction(async () => {
      const body = row.kind === "line" ? { lineIds: [row.id], expectedLines: { [row.id]: lineTokens.current[row.id] } }
        : { receiptIds: [row.id], expectedLines: {} };
      await queue.current!.mutate(`/api/receipts/trips/${trip.id}/members`, "DELETE", () => body);
      setRefreshNonce(n => n + 1);
    }, setActionError);
  }

  function toggleSelected(id: string) {
    const candidate = candidates.find(c => c.id === id && c.kind === "line");
    if (candidate && !selected.has(id)) selectedTokens.current[id] = candidate.revision!;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const status = trip.status;
  const exported_ = status === "exported";

  // Charge-centric picker: card charges (AMEX lines) vs cash/digital receipts.
  // The candidates endpoint already dedupes (a receipt matched to a line is
  // folded into that line row), so each expense appears once.
  const chargeLines = candidates.filter((c) => c.kind === "line");
  const cashReceipts = candidates.filter((c) => c.kind === "receipt");

  function renderCandidateRow(row: CandidateRow) {
    const reason = candidateDisableReason(row, trip.id);
    const disabled = reason !== null;
    const checked = selected.has(row.id);
    return (
      <label
        key={`${row.kind}-${row.id}`}
        className={[
          "flex items-center gap-2 rounded-lg border px-3 py-2",
          disabled
            ? "cursor-not-allowed border-gray-100 bg-gray-50 opacity-70"
            : "cursor-pointer border-gray-100 hover:bg-gray-50",
        ].join(" ")}
      >
        <input
          type="checkbox"
          className="h-4 w-4 accent-amber-500"
          disabled={disabled || exported_}
          checked={checked}
          onChange={() => toggleSelected(row.id)}
        />
        <Pill tone={row.kind === "line" ? "outline" : "purple"} size="sm">
          {row.kind === "line"
            ? "Card charge"
            : formatPaymentPath(row.paymentPath)}
        </Pill>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-gray-900">
            {row.merchant ?? "(unnamed)"}
          </div>
          <div className="text-[11px] text-gray-500">
            {formatDate(row.transactionDate)}
            {row.month ? ` · ${row.month}` : ""}
            {row.kind === "line"
              ? row.matchedReceiptId
                ? " · receipt ✓"
                : " · no receipt"
              : ""}
          </div>
        </div>
        {disabled && row.ownedByTripId && (
          <Link
            href={`/receipts/trips/${row.ownedByTripId}`}
            className="shrink-0 text-[11px] font-medium text-amber-700 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            owned by another trip →
          </Link>
        )}
        <span className="shrink-0 text-[12px] tabular-nums text-gray-700">
          {row.amountMinor != null
            ? formatAmountMinor(row.amountMinor, row.currency)
            : "—"}
        </span>
      </label>
    );
  }

  return (
    <div onCompositionStartCapture={() => { composing.current = true; }}
      onCompositionEndCapture={() => { composing.current = false; if (!queue.current!.idle) void queue.current!.save().catch(err => setFieldError(err.message)); }}
      onClickCapture={e => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || a.target === "_blank") return;
        e.preventDefault(); e.stopPropagation(); void guardedNavigate(() => router.push(a.getAttribute("href")!));
      }} className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-4">
        <Link
          href="/receipts/trips"
          className="text-[13px] font-medium text-amber-700 hover:underline"
        >
          ← All trips
        </Link>
      </div>

      {/* Header: editable fields + status actions */}
      <Card className="mb-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-gray-900">
              {trip.trip_name?.trim() || "(unnamed trip)"}
            </h1>
            <Pill tone={tripStatusTone(status)} size="md" dot>
              {status}
            </Pill>
          </div>
          {!exported_ && (
            <div className="flex gap-2">
              {(status === "candidate" || status === "rejected") && (
                <Btn
                  kind="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => patchStatus("confirmed")}
                >
                  Confirm trip
                </Btn>
              )}
              {(status === "candidate" || status === "confirmed") && (
                <Btn
                  kind="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => patchStatus("rejected")}
                >
                  Reject trip
                </Btn>
              )}
            </div>
          )}
        </div>
        {exported_ && (
          <p className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-[12px] text-blue-700">
            This trip is sealed in an export and cannot be changed.
          </p>
        )}
        {actionError && (
          <p className="mb-3 text-[12px] text-red-600">{actionError} <button type="button" onClick={() => window.location.reload()} className="underline">Reload to review</button></p>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Trip name">
            <TextInput
              value={fields.tripName}
              onChange={(e) =>
                setFields((s) => ({ ...s, tripName: e.target.value }))
              }
            />
          </Field>
          <Field label="Primary location">
            <TextInput
              value={fields.primaryLocation}
              onChange={(e) =>
                setFields((s) => ({ ...s, primaryLocation: e.target.value }))
              }
            />
          </Field>
          <Field label="Start date" required>
            <TextInput
              type="date"
              value={fields.startDate}
              onChange={(e) =>
                setFields((s) => ({ ...s, startDate: e.target.value }))
              }
            />
          </Field>
          <Field label="End date" required>
            <TextInput
              type="date"
              value={fields.endDate}
              onChange={(e) =>
                setFields((s) => ({ ...s, endDate: e.target.value }))
              }
            />
          </Field>
          <Field label="Purpose" className="md:col-span-2">
            <TextInput
              value={fields.purpose}
              onChange={(e) =>
                setFields((s) => ({ ...s, purpose: e.target.value }))
              }
            />
          </Field>
        </div>
        {fieldError && (
          <p className="mt-2 text-[12px] text-red-600">{fieldError} <button type="button" onClick={() => window.location.reload()} className="underline">Reload to review</button></p>
        )}
        <div className="mt-3 flex justify-end">
          <Btn kind="primary" size="md" disabled={saving || exported_} onClick={saveFields}>
            {saving ? "Saving…" : fieldSaved ? "Re-save" : "Save"}
          </Btn>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Members */}
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-gray-900">
              Members ({memberRows.length})
            </h2>
            <span className="text-[11px] text-gray-400">date · merchant · amount</span>
          </div>
          {memberRows.length === 0 ? (
            <p className="text-[13px] text-gray-500">No charges attached yet.</p>
          ) : (
            <div className="space-y-1.5">
              {memberRows.map((row) => (
                <div
                  key={`${row.kind}-${row.id}`}
                  className="flex items-center gap-2 rounded-lg border border-gray-100 px-3 py-2"
                >
                  <Pill tone={row.kind === "line" ? "outline" : "purple"} size="sm">
                    {row.kind === "line"
                      ? "Card charge"
                      : formatPaymentPath(row.paymentPath)}
                  </Pill>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-gray-900">
                      {row.merchant ?? "(unnamed)"}
                    </div>
                    <div className="text-[11px] text-gray-500">
                      {formatDate(row.date)}
                      {row.month ? ` · ${row.month}` : ""}
                      {row.status ? ` · ${row.status}` : ""}
                    </div>
                  </div>
                  {row.sealed && (
                    <Pill tone="gray" size="sm">
                      sealed
                    </Pill>
                  )}
                  <span className="shrink-0 text-[12px] tabular-nums text-gray-700">
                    {row.amountMinor != null
                      ? formatAmountMinor(row.amountMinor, "JPY")
                      : "—"}
                  </span>
                  {!exported_ && (
                    <Btn
                      kind="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => detach(row)}
                    >
                      Detach
                    </Btn>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Add charges */}
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[14px] font-semibold text-gray-900">Add charges</h2>
            <span className="text-[11px] text-gray-400">
              {showAll ? "all dates" : "±45 days around trip dates"}
            </span>
          </div>
          <div className="mb-3 flex items-center gap-2">
            <TextInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search merchant…"
            />
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className={[
                "shrink-0 rounded-lg border px-3 py-1.5 text-[12px] font-medium",
                showAll
                  ? "border-amber-300 bg-amber-50 text-amber-800"
                  : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
              ].join(" ")}
            >
              {showAll ? "Showing all" : "Show all"}
            </button>
          </div>

          {candLoading ? (
            <p className="text-[12px] text-gray-400">Loading…</p>
          ) : candidates.length === 0 ? (
            <p className="text-[13px] text-gray-500">
              No charges in range. Toggle “Show all” or adjust the search.
            </p>
          ) : (
            <div className="max-h-80 space-y-3 overflow-y-auto">
              {chargeLines.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                    Card charges ({chargeLines.length})
                  </div>
                  <div className="space-y-1.5">
                    {chargeLines.map(renderCandidateRow)}
                  </div>
                </div>
              )}
              {cashReceipts.length > 0 && (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-gray-500">
                    Cash & digital receipts ({cashReceipts.length})
                  </div>
                  <div className="space-y-1.5">
                    {cashReceipts.map(renderCandidateRow)}
                  </div>
                </div>
              )}
            </div>
          )}
          {attachError && (
            <p className="mt-2 text-[12px] text-red-600">{attachError} <button type="button" onClick={() => window.location.reload()} className="underline">Reload to review</button></p>
          )}
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[11px] text-gray-400">
              {selected.size} selected
            </span>
            <Btn
              kind="primary"
              size="sm"
              disabled={busy || exported_ || selected.size === 0}
              onClick={attach}
            >
              {busy ? "Attaching…" : "Attach selected"}
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}
