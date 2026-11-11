"use client";

// Capture-pipeline health banner (backlog #19 + #22). Silent when the pipeline
// is healthy; when a class is lit it names the class, the count, and the oldest
// age, then lists the affected receipts (filename, review link, age, reason)
// with the honest next action — not counts alone:
//   never_enqueued    → Enqueue button (POST /api/receipts/:id/enqueue)
//   render_failed     → Retry render button (POST /api/receipts/:id/render-retry)
//   extraction_failed → no auto-retry: replace the file or enter fields by hand
//     (the /enqueue contract intentionally does not admit failed rows, and a
//     broad unsafe retry endpoint is deliberately NOT provided)
//   consumer_stalled / render_stalled → waiting; if it persists, check the Mac
// Red for errors, amber for warns.
//
// Review B5: a FAILED detail query renders an explicit "details unavailable"
// line with a reload action — never a silent empty list. Action failures
// distinguish a 409 refusal (endpoint's own validated message; do NOT retry
// the same action) from a temporary failure (safe to try again); 5xx bodies
// are generic strings and internals are never rendered.
// N1: when a class has more affected rows than shown, the cap is disclosed
// ("showing oldest 50 of 51") with the Review queue as the full list.

import { useState } from "react";
import Link from "next/link";
import type {
  ActionFailureKind,
  PipelineAttention,
  PipelineClassReport,
  PipelineDetailKind,
} from "@/lib/receipts/pipeline-health";
import {
  classifyActionFailure,
  formatAge,
  isActionDisabledByFailure,
} from "@/lib/receipts/pipeline-health";

interface Props {
  lit: PipelineClassReport[];
  /** Detail rows per lit class (filename, review link, age, reason),
   *  oldest-first. missing_manifest has no rows by design. */
  attentionByKind: Partial<Record<PipelineDetailKind, PipelineAttention>>;
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
        const attention = attentionByKind[c.kind];
        if (!attention) return null;
        return (
          <div key={`${c.kind}-rows`} className="mt-2 space-y-1">
            {attention.unavailable ? (
              <p className="text-xs text-red-700">
                ↳ affected receipts could not be loaded —{" "}
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="font-semibold underline underline-offset-2"
                >
                  reload the page
                </button>{" "}
                to retry.
              </p>
            ) : (
              <>
                {attention.rows.map((r) => (
                  <ActionRow key={r.id} kind={attention.kind} receipt={r} />
                ))}
                {attention.total > attention.rows.length && (
                  <p className="text-xs text-gray-500">
                    showing oldest {attention.rows.length} of {attention.total} —{" "}
                    <Link
                      href="/receipts/review"
                      className="font-medium underline decoration-gray-300 underline-offset-2 hover:decoration-gray-500"
                    >
                      open the Review queue
                    </Link>{" "}
                    for the rest
                  </p>
                )}
              </>
            )}
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
  receipt: PipelineAttention["rows"][number];
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

type ButtonState = "idle" | "busy" | "done" | "failed";

interface ActionFailure {
  kind: ActionFailureKind;
  /** Safe endpoint-provided message (409 refusal). Null for other kinds. */
  message: string | null;
}

/**
 * Shared action-button behavior (B5 + R4): 200 → done; anything else is
 * classified by classifyActionFailure —
 *   refused (409)  → the endpoint's own validated message; action disabled
 *                    (prohibited in this state until refresh)
 *   removed (404)  → stale row; reload guidance; action disabled
 *   auth (401/403) → session lost; sign-in guidance; action disabled
 *   temporary      → transport/server failure; retry stays possible
 * Only 409 bodies carry an endpoint message worth showing (validated by the
 * route); 5xx bodies are generic — no SQL/internal text reaches the UI.
 */
function useActionButton(endpoint: string): {
  state: ButtonState;
  failure: ActionFailure | null;
  run: () => Promise<void>;
} {
  const [state, setState] = useState<ButtonState>("idle");
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  async function run() {
    setState("busy");
    setFailure(null);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      if (res.ok) {
        setState("done");
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const text = typeof body?.error === "string" ? body.error : null;
      const kind = classifyActionFailure(res.status);
      setFailure({
        kind,
        message: kind === "refused" ? (text ?? "this receipt is not in the recoverable state") : null,
      });
      setState("failed");
    } catch {
      // Network-level failure — no status to classify; temporary.
      setFailure({ kind: "temporary", message: null });
      setState("failed");
    }
  }
  return { state, failure, run };
}

function EnqueueButton({ receiptId }: { receiptId: string }) {
  const { state, failure, run } = useActionButton(`/api/receipts/${receiptId}/enqueue`);
  return <ActionButton state={state} failure={failure} run={run} label="Enqueue" doneLabel="Enqueued ✓" />;
}

function RetryRenderButton({ receiptId }: { receiptId: string }) {
  const { state, failure, run } = useActionButton(`/api/receipts/${receiptId}/render-retry`);
  return (
    <ActionButton
      state={state}
      failure={failure}
      run={run}
      label="Retry render"
      doneLabel="Retrying next cycle ✓"
    />
  );
}

/** Per-failure-kind operator guidance (R4). Refusal keeps the endpoint's own
 *  safe message; the others state the honest next step. */
const FAILURE_NOTE: Record<ActionFailureKind, string> = {
  refused: "", // rendered separately with the endpoint message
  removed: "receipt no longer exists — reload the page",
  auth: "session expired — sign in again",
  temporary: "temporarily unavailable — try again",
};

function ActionButton({
  state,
  failure,
  run,
  label,
  doneLabel,
}: {
  state: ButtonState;
  failure: ActionFailure | null;
  run: () => Promise<void>;
  label: string;
  doneLabel: string;
}) {
  if (state === "done") {
    return (
      <span className="shrink-0 font-medium text-green-700">{doneLabel}</span>
    );
  }
  const kind = failure?.kind ?? null;
  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={state === "busy" || isActionDisabledByFailure(kind)}
        className="shrink-0 rounded-lg bg-red-500 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-red-600 disabled:opacity-60"
      >
        {state === "busy" ? "…" : label}
      </button>
      {kind === "refused" && (
        <span className="max-w-[46ch] truncate text-red-700" title={failure?.message ?? undefined}>
          not allowed — {failure?.message}
        </span>
      )}
      {kind !== null && kind !== "refused" && (
        <span className="shrink-0 text-red-700">{FAILURE_NOTE[kind]}</span>
      )}
    </>
  );
}
