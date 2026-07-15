"use client";

// "Create revision" affordance for a finalized export month.
//
// createExportRevision is API-only (POST /api/receipts/export/[month]?correction=true)
// — there was no UI to start a revision, so amending a sealed month (e.g. adding
// the proofs ZIP that didn't exist when rev 1 sealed) required a curl with a
// Clerk session cookie. This button makes it click-driven: enter a correction
// reason → POST → the revision-N draft appears on the export page → Rebuild →
// review → Finalize, all in the UI.
//
// The prior finalized export stays byte-identical (compliance guarantee); the
// revision is a new draft that supersedes it.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Btn } from "@/components/ui/btn";

export function CreateRevisionButton({
  month,
  monthLabel,
}: {
  month: string;
  monthLabel: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRevision, setCreatedRevision] = useState<number | null>(null);

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Enter a correction reason — it's recorded in the manifest, README notice, and audit log.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/receipts/export/${month}?correction=true`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ correctionReason: trimmed }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        revision?: number;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not create revision.");
        return;
      }
      setCreatedRevision(json.revision ?? null);
      setReason("");
      // Refresh so the new revision draft surfaces (getExport returns the
      // highest revision); "Rebuild draft" then becomes available.
      router.refresh();
    } catch {
      setError("Network error — revision not created.");
    } finally {
      setBusy(false);
    }
  }

  if (createdRevision !== null) {
    return (
      <p className="mt-3 text-[11.5px] text-amber-800">
        Revision {createdRevision} created. Click <strong>Rebuild draft</strong> to
        build the bundle (CSV + proofs ZIP + notice) into it, then review & finalize.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11.5px] font-semibold text-amber-900 hover:bg-amber-100"
      >
        ＋ Create revision (add proofs / amend)
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
      <p className="text-[12px] text-amber-900">
        Create a new revision for <strong>{monthLabel}</strong>. The current finalized
        export stays byte-identical; this opens a new draft you rebuild + finalize.
      </p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        disabled={busy}
        placeholder="様式移行: 証憠ZIP・No列・お知らせ追加 (format transition: proofs bundle added)"
        className="mt-2 w-full rounded-md border border-amber-300 bg-white px-2 py-1.5 text-[12.5px] text-gray-900 outline-none focus:border-amber-500 disabled:bg-gray-50"
      />
      <div className="mt-2 flex items-center gap-2">
        <Btn kind="primary" size="sm" onClick={submit} disabled={busy}>
          {busy ? "Creating…" : "Create revision"}
        </Btn>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
            setReason("");
          }}
          disabled={busy}
          className="text-[12px] text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
