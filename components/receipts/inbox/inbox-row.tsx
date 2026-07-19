"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { EmailReceiptIntake } from "@/lib/receipts/types";

/**
 * One triage row in /receipts/inbox. Promote creates a real receipt (the row
 * then leaves pending_triage and disappears on refresh); Reject requires a
 * reason. Promote is disabled when the row has no promotable attachment
 * (mirrors the server assertPromotable check) and the reject_reason is shown
 * inline so the operator sees WHY it can't be promoted.
 */
export function InboxRow({ intake }: { intake: EmailReceiptIntake }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");

  const promotable = intake.status === "pending_triage" && !!intake.attachment_r2_key;

  function refresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  async function handlePromote() {
    setError(null);
    try {
      const res = await fetch(
        `/api/receipts/inbox/${encodeURIComponent(intake.id)}/promote`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Promote failed (HTTP ${res.status}).`);
      }
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Promote failed.");
    }
  }

  async function handleReject() {
    setError(null);
    if (!reason.trim()) {
      setError("A reject reason is required.");
      return;
    }
    try {
      const res = await fetch(
        `/api/receipts/inbox/${encodeURIComponent(intake.id)}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Reject failed (HTTP ${res.status}).`);
      }
      setRejectOpen(false);
      setReason("");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed.");
    }
  }

  return (
    <li className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">
            {intake.from_address}
          </p>
          <p className="truncate text-sm text-gray-600">
            {intake.subject || <span className="text-gray-400">(no subject)</span>}
          </p>
          <p className="mt-0.5 text-xs text-gray-400">
            {formatReceived(intake.received_at)}
          </p>
          {intake.to_address && (
            <p className="truncate text-xs text-gray-400">→ {intake.to_address}</p>
          )}
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <VerdictBadge label="SPF" pass={intake.spf_pass === 1} />
          <VerdictBadge label="DKIM" pass={intake.dkim_pass === 1} />
        </div>
      </div>

      <div className="mt-3">
        {intake.attachment_r2_key ? (
          <p className="text-xs text-gray-700">
            <span className="text-gray-400">Attachment: </span>
            {intake.attachment_filename || "untitled"}
            {intake.attachment_content_type
              ? ` · ${intake.attachment_content_type}`
              : ""}
          </p>
        ) : (
          <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
            {intake.reject_reason || "No promotable attachment."}
          </p>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs font-medium text-red-600">{error}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handlePromote}
          disabled={!promotable || isPending}
          className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
          title={promotable ? "Promote to a real receipt" : "Nothing to promote"}
        >
          Promote
        </button>
        <button
          type="button"
          onClick={() => {
            setRejectOpen((v) => !v);
            setError(null);
          }}
          disabled={isPending}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50"
        >
          {rejectOpen ? "Cancel" : "Reject"}
        </button>
      </div>

      {rejectOpen && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <label className="block text-xs font-medium text-gray-600">
            Reason (required)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:border-amber-500 focus:outline-none"
              placeholder="e.g. personal expense, not a business receipt"
            />
          </label>
          <button
            type="button"
            onClick={handleReject}
            disabled={isPending}
            className="mt-2 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
          >
            Confirm reject
          </button>
        </div>
      )}
    </li>
  );
}

function VerdictBadge({ label, pass }: { label: string; pass: boolean }) {
  return (
    <span
      title={`${label} ${pass ? "pass" : "fail"}`}
      className={[
        "rounded-full px-2 py-0.5 text-[10px] font-semibold",
        pass
          ? "bg-green-100 text-green-800"
          : "bg-red-100 text-red-700",
      ].join(" ")}
    >
      {label} {pass ? "✓" : "✗"}
    </span>
  );
}

function formatReceived(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}
