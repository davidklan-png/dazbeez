// Render-leg failure admission + deliberate recovery (backlog #22).
//
// A needs_render=1 receipt whose email body failed to render permanently is
// marked extraction_state='failed' with stage:'render' in extraction_json (the
// architect-preferred failure surface — no migration; the queue pill, review
// attention codes and pipeline health all read it). needs_render stays 1, so
// the row itself remains the discriminator between a terminal RENDER failure
// and a terminal EXTRACTION failure.
//
// Recovery is deliberately narrow, mirroring /enqueue's strict 409 contract:
// the ONLY admitted action clears the terminal marker (extraction_state back
// to 'captured') so the Mac render leg picks the row up again on its next
// cycle. It does not enqueue (render rows enqueue via /render only, after the
// derivative lands), does not touch business fields, and refuses any receipt
// a human has already advanced past needs_review — a late retry must not
// un-review or roll back operator data.

import type { ReceiptRecord } from "@/lib/receipts/types";

export type RenderAdmission =
  | { ok: true }
  | { ok: false; status: 409; error: string };

/** Statuses a render-leg failure report / retry may still act on. Anything
 * past needs_review means a human handled the receipt — locked (mirrors the
 * /extract and /extraction-failed guards, incl. sealed/finalized months,
 * whose rows are always past needs_review). */
const RENDER_PENDING_STATUSES = ["captured", "needs_review"] as const;

function lockedAdmission(receipt: ReceiptRecord): RenderAdmission {
  return {
    ok: false,
    status: 409,
    error:
      `Receipt is ${receipt.status} and cannot be acted on by the render ` +
      "pipeline — a human has already advanced it.",
  };
}

/**
 * Admission for POST /api/receipts/[id]/render-failed (the consumer's
 * terminal-failure report). Only a render-pending receipt (needs_render=1)
 * still in a pre-review status may be marked terminally failed; the report is
 * idempotent (re-posting over the same terminal marker is fine).
 */
export function admitRenderFailure(receipt: ReceiptRecord): RenderAdmission {
  if (receipt.needs_render !== 1) {
    return {
      ok: false,
      status: 409,
      error:
        "Receipt is not awaiting a render (requires needs_render=1). " +
        `Actual: needs_render=${receipt.needs_render ?? 0}, ` +
        `extraction_state='${receipt.extraction_state ?? "captured"}'.`,
    };
  }
  if (!RENDER_PENDING_STATUSES.includes(receipt.status as never)) {
    return lockedAdmission(receipt);
  }
  return { ok: true };
}

/**
 * Admission for POST /api/receipts/[id]/render-retry (the operator's
 * deliberate recovery). Admits ONLY the genuine terminal-render-failure
 * state: needs_render=1 AND extraction_state='failed' AND pre-review status.
 * Anything else — never marked failed, already recovered, mid-flight, or
 * human-advanced — is rejected with the actual state named, mirroring
 * /enqueue. Legacy stalled rows (needs_render=1, extraction_state='captured',
 * no marker) are NOT admissible: they already retry every cycle, and this
 * tool must not widen into a general render-kick.
 */
export function admitRenderRetry(receipt: ReceiptRecord): RenderAdmission {
  if (receipt.needs_render !== 1) {
    return {
      ok: false,
      status: 409,
      error:
        "Receipt is not in the render-retry recoverable state " +
        "(requires needs_render=1 AND extraction_state='failed'). " +
        `Actual: needs_render=${receipt.needs_render ?? 0}, ` +
        `extraction_state='${receipt.extraction_state ?? "captured"}'.`,
    };
  }
  if ((receipt.extraction_state ?? "captured") !== "failed") {
    return {
      ok: false,
      status: 409,
      error:
        "Receipt is not in the render-retry recoverable state " +
        "(requires needs_render=1 AND extraction_state='failed'). " +
        `Actual: needs_render=${receipt.needs_render ?? 0}, ` +
        `extraction_state='${receipt.extraction_state ?? "captured"}' ` +
        "(legacy stalled render rows retry automatically and need no retry).",
    };
  }
  if (!RENDER_PENDING_STATUSES.includes(receipt.status as never)) {
    return lockedAdmission(receipt);
  }
  return { ok: true };
}
