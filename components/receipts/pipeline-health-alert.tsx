"use client";

// Capture-pipeline health banner (backlog #19 + #22). Silent when the pipeline
// is healthy; when a class is lit it names the class, the count, and the oldest
// age, then lists the affected receipts (filename, review link, age, reason)
// with the honest next action — not counts alone:
//   never_enqueued  → Enqueue button (POST /api/receipts/:id/enqueue)
//   render_failed   → Retry render button (POST /api/receipts/:id/render-retry)
//   extraction_failed → no auto-retry: replace the file or enter fields by hand
//     (the /enqueue contract intentionally does not admit failed rows, and a
//     broad unsafe retry endpoint is deliberately NOT provided)
//   consumer_stalled / render_stalled → waiting; if it persists, check the Mac
// Red for errors, amber for warns.

import { useState } from "react";
import Link from "next/link";
import type {
  PipelineAttentionReceipt,
  PipelineClassReport,
  PipelineDetailKind,
} from "@/lib/receipts/pipeline-health";
import { formatAge } from "@/lib/receipts/pipeline-health";

interface Props {
  lit: PipelineClassReport[];
  /** Detail rows per lit class (filename, review link, age, reason),
   *  oldest-first. missing_manifest has no rows by design. */
  attentionByKind: Partial<Record<PipelineDetailKind, PipelineAttentionReceipt[]>>;
}

/** The honest next action per class (a button where a safe one exists). */
const STATIC_ACTION: Partial<Record<PipelineDetailKind, string>> = {
  render_failed: "", // button below
  extraction_failed: "replace the file or enter fields by hand in Review",
  consumer_stalled: "waiting on the Mac consumer — check it if this persists",
  render_stalled: "waiting on the Mac render leg — check it if this persists",
  never_enqueued: "", // button below
};

export function PipelineHealthAlert({ lit, attentionByKind }: Props) {
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
      {lit.map((c) => {
        if (c.kind === "missing_manifest") return null;
        const kind = c.kind as PipelineDetailKind;
        const rows = attentionByKind[kind] ?? [];
        if (rows.length === 0) return null;
        return (
          <div key={`${c.kind}-rows`} className="mt-2 space-y-1">
            {rows.map((r) => (
              <ActionRow key={r.id} kind={kind} receipt={r} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ActionRow({
  kind,
  receipt,
}: {
  kind: PipelineDetailKind;
  receipt: PipelineAttentionReceipt;
}) {
  const label = receipt.original_filename ?? receipt.id.slice(0, 8);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span className="text-gray-500">↳</span>
      <Link
        href={`/receipts/review/${receipt.id}`}
        className="max-w-[24ch] truncate font-medium underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500"
      >
        {label}
      </Link>
      <span className="text-gray-500">{formatAge(receipt.ageMs)} old</span>
      {receipt.reason && (
        <span className="max-w-[46ch] truncate text-gray-600" title={receipt.reason}>
          {receipt.reason}
        </span>
      )}
      {kind === "never_enqueued" && <EnqueueButton receiptId={receipt.id} />}
      {kind === "render_failed" && <RetryRenderButton receiptId={receipt.id} />}
      {STATIC_ACTION[kind] && (
        <span className="text-gray-600">— {STATIC_ACTION[kind]}</span>
      )}
    </div>
  );
}

type ButtonState = "idle" | "busy" | "done" | "error";

function useActionButton(endpoint: string): {
  state: ButtonState;
  run: () => Promise<void>;
} {
  const [state, setState] = useState<ButtonState>("idle");
  async function run() {
    setState("busy");
    try {
      const res = await fetch(endpoint, { method: "POST" });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }
  return { state, run };
}

function EnqueueButton({ receiptId }: { receiptId: string }) {
  const { state, run } = useActionButton(`/api/receipts/${receiptId}/enqueue`);
  return <ActionButton state={state} run={run} label="Enqueue" doneLabel="Enqueued ✓" />;
}

function RetryRenderButton({ receiptId }: { receiptId: string }) {
  const { state, run } = useActionButton(`/api/receipts/${receiptId}/render-retry`);
  return (
    <ActionButton
      state={state}
      run={run}
      label="Retry render"
      doneLabel="Retrying next cycle ✓"
    />
  );
}

function ActionButton({
  state,
  run,
  label,
  doneLabel,
}: {
  state: ButtonState;
  run: () => Promise<void>;
  label: string;
  doneLabel: string;
}) {
  if (state === "done") {
    return (
      <span className="shrink-0 font-medium text-green-700">{doneLabel}</span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={state === "busy"}
        className="shrink-0 rounded-lg bg-red-500 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-60"
      >
        {state === "busy" ? "…" : label}
      </button>
      {state === "error" && (
        <span className="shrink-0 text-red-700">failed — retry</span>
      )}
    </>
  );
}
