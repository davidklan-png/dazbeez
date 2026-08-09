"use client";

// Capture-pipeline health banner (backlog #19). Silent when the pipeline is
// healthy; when a class is lit it names the class, the count, and the oldest
// age. Class 1 (never-enqueued) is the one with an in-UI fix: each affected
// receipt gets an Enqueue button that POSTs /api/receipts/:id/enqueue (the
// recovery endpoint from the 2026-08-09 fix). Red for errors, amber for warns.

import { useState } from "react";
import type {
  NeverEnqueuedReceipt,
  PipelineClassReport,
} from "@/lib/receipts/pipeline-health";

interface Props {
  lit: PipelineClassReport[];
  neverEnqueuedReceipts: NeverEnqueuedReceipt[];
}

type EnqueueState = "idle" | "enqueuing" | "enqueued" | "error";

export function PipelineHealthAlert({ lit, neverEnqueuedReceipts }: Props) {
  if (lit.length === 0) return null;
  const hasError = lit.some((c) => c.severity === "error");
  const tone = hasError
    ? { box: "border-red-200 bg-red-50", title: "text-red-800", item: "text-red-700" }
    : { box: "border-amber-200 bg-amber-50", title: "text-amber-800", item: "text-amber-700" };

  return (
    <div className={`mb-6 rounded-2xl border px-4 py-3 text-sm ${tone.box}`}>
      <p className={`font-semibold ${tone.title}`}>Capture pipeline needs attention</p>
      <ul className={`mt-1.5 space-y-0.5 text-xs ${tone.item}`}>
        {lit.map((c) => (
          <li key={c.kind}>• {c.summary}</li>
        ))}
      </ul>
      {neverEnqueuedReceipts.length > 0 && (
        <div className="mt-3 space-y-1">
          {neverEnqueuedReceipts.map((r) => (
            <EnqueueRow key={r.id} receipt={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function EnqueueRow({ receipt }: { receipt: NeverEnqueuedReceipt }) {
  const [state, setState] = useState<EnqueueState>("idle");

  async function enqueue() {
    setState("enqueuing");
    try {
      const res = await fetch(`/api/receipts/${receipt.id}/enqueue`, {
        method: "POST",
      });
      setState(res.ok ? "enqueued" : "error");
    } catch {
      setState("error");
    }
  }

  const label = receipt.original_filename ?? receipt.id.slice(0, 8);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="truncate text-red-700">↳ {label}</span>
      {state === "enqueued" ? (
        <span className="shrink-0 font-medium text-green-700">Enqueued ✓</span>
      ) : (
        <button
          type="button"
          onClick={enqueue}
          disabled={state === "enqueuing"}
          className="shrink-0 rounded-lg bg-red-500 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-60"
        >
          {state === "enqueuing" ? "Enqueuing…" : "Enqueue"}
        </button>
      )}
      {state === "error" && (
        <span className="shrink-0 text-red-700">failed — retry</span>
      )}
    </div>
  );
}
