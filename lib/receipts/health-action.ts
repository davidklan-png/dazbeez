// Client-safe health-row action request path (Enqueue / Retry render).
//
// Extracted from the PipelineHealthAlert hook so the ACTUAL decision path —
// the fetch call, response parsing, safe-message selection, and failure
// classification — is executable in tests with an injected fetch (the same
// client-safe-extraction pattern as upload-pool/single-flight, backlog #11).
// The hook keeps only state wiring.

import {
  classifyActionFailure,
  type ActionFailureKind,
} from "@/lib/receipts/pipeline-health";

export type HealthActionOutcome =
  | { status: "done" }
  | { status: "failed"; kind: ActionFailureKind; message: string | null };

/**
 * POST a health-row action and classify the outcome.
 *
 * Safe-message policy: only a 409 refusal keeps the endpoint's own validated
 * `error` string (the render-retry/render-failed routes emit safe ones).
 * Any other failure — including 5xx bodies, which may contain internal
 * error text — is reported by its fixed note, never by the raw body. A
 * rejected fetch (network loss, no status) is an UNCONFIRMED outcome: the
 * mutation may have committed, so the caller must point the operator at
 * current state instead of inviting an immediate repeat.
 */
export async function performHealthAction(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthActionOutcome> {
  try {
    const res = await fetchImpl(endpoint, { method: "POST" });
    if (res.ok) return { status: "done" };
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null; // non-JSON body — nothing safe to read
    }
    const rawError =
      body !== null && typeof body === "object"
        ? (body as { error?: unknown }).error
        : undefined;
    const text = typeof rawError === "string" ? rawError : null;
    const kind = classifyActionFailure(res.status);
    return {
      status: "failed",
      kind,
      message:
        kind === "refused"
          ? text ?? "this receipt is not in the recoverable state"
          : null,
    };
  } catch {
    // Network-level failure — no status exists; the outcome is unconfirmed.
    return { status: "failed", kind: "unconfirmed", message: null };
  }
}
