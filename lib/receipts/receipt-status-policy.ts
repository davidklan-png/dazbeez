// Receipt lifecycle status-transition policy for the public review PATCH
// (app/api/receipts/[id]/route.ts) and the review form
// (components/receipts/review/form-pane.tsx).
//
// Authority split (audit 2026-07-21, orphan remediation Phase 1):
//   • The public review PATCH owns ONLY the captured/needs_review → reviewed
//     promotion. "Mark reviewed" is a promotion, never a lifecycle demotion.
//   • The reconciliation flow (db.ts updateAmexReconciliation) owns
//     → reconciled. The export flow owns → exported. Archived is terminal.
//   • Ordinary field autosaves MUST omit status entirely — they must not even
//     re-send the current status, because a stale client status value on a
//     receipt that an internal flow has since advanced (e.g. reconciled) used
//     to let the generic PATCH downgrade it back to "reviewed".
//
// Pure + client-safe (type-only import) so the policy is unit-tested without
// D1/auth and reused client-side to decide whether "Mark reviewed" is shown.

import type { ReceiptStatus } from "@/lib/receipts/types";

/** The only status value the public review PATCH is permitted to request. */
export const REVIEW_PATCH_ALLOWED_STATUS: ReceiptStatus = "reviewed";

/**
 * True when "Mark reviewed" is a meaningful promotion — i.e. the receipt is
 * still in a pre-review state. Used by the form to hide/disable the button for
 * reviewed/reconciled/exported/archived receipts (no-op at best, a forbidden
 * downgrade at worst).
 */
export function canPromoteToReviewed(status: ReceiptStatus): boolean {
  return status === "captured" || status === "needs_review";
}

/**
 * The SINGLE shared gate for the "Mark reviewed" affordance — used by BOTH the
 * button (disabled) and the `s` keyboard shortcut, so the two can never drift
 * (audit 2026-07-21 architect review: the shortcut previously fired
 * save-and-advance for a non-promotable, merely-unlocked receipt). True only
 * when the form is unlocked AND the receipt is still in a pre-review state.
 *
 * Pure + testable: `locked` is the form's seal state (a boolean prop), so the
 * full gate is unit-tested without a React/keyboard harness.
 */
export function canMarkReviewed(status: ReceiptStatus, locked: boolean): boolean {
  return !locked && canPromoteToReviewed(status);
}

export type StatusTransitionPlan =
  | { outcome: "apply"; status: "reviewed" } // promote captured/needs_review
  | { outcome: "noop" } // no status field sent, or already reviewed (idempotent)
  | { outcome: "reject"; httpStatus: 400 | 409; reason: string };

/**
 * Decide what the public review PATCH should do with a requested status.
 *
 * Callers pass the receipt's current status and the raw `status` value from the
 * request body (undefined when the field is absent — the ordinary-autosave
 * case). Returns one of:
 *
 *   • apply  — set status to "reviewed" (captured/needs_review → reviewed).
 *   • noop   — leave status untouched. Covers both "field not sent" (autosave)
 *              and "already reviewed, requested reviewed" (idempotent).
 *   • reject — refuse with an HTTP status + reason. Non-"reviewed" values are
 *              400 (this endpoint doesn't own them); attempts to demote a
 *              reconciled/exported/archived receipt are 409.
 *
 * Internal reconciliation/export functions are unaffected — they write status
 * through their own paths and never route through this planner.
 */
export function planReviewStatusTransition(args: {
  currentStatus: ReceiptStatus;
  requestedStatus: string | undefined;
}): StatusTransitionPlan {
  const { currentStatus, requestedStatus } = args;

  // Ordinary field autosave: no status field → never touch lifecycle status.
  if (requestedStatus === undefined) {
    return { outcome: "noop" };
  }

  // This endpoint owns only the "reviewed" promotion. Any other requested
  // status (including reconciled/exported/archived) belongs to a different
  // flow and is rejected — the review PATCH is not a generic status setter.
  if (requestedStatus !== REVIEW_PATCH_ALLOWED_STATUS) {
    return {
      outcome: "reject",
      httpStatus: 400,
      reason: `This endpoint only accepts status="reviewed"; status "${requestedStatus}" is not permitted here.`,
    };
  }

  // requestedStatus === "reviewed"
  if (currentStatus === "captured" || currentStatus === "needs_review") {
    return { outcome: "apply", status: "reviewed" };
  }
  if (currentStatus === "reviewed") {
    // Idempotent: already reviewed. Don't write (avoids a pointless UPDATE +
    // keeps the audit trail quiet), but don't error either.
    return { outcome: "noop" };
  }

  // currentStatus is reconciled/exported/archived — these lifecycle states are
  // owned by reconciliation/export (and archived is terminal). Refusing the
  // downgrade here is the authoritative guard. (exported/archived field edits
  // are also refused earlier in the route, but a status-only request reaches
  // this planner, so the guard must stand on its own.)
  return {
    outcome: "reject",
    httpStatus: 409,
    reason: `Receipt is "${currentStatus}" — its lifecycle status cannot be changed to "reviewed" from the review endpoint.`,
  };
}
