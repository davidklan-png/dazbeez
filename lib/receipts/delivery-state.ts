// Delivery state machine for automated monthly pack delivery (Phase B; D2).
//
// "Send failure is finalize failure" — but ONLY in the sense that the month is
// not closed for reporting until delivery succeeds. It is NOT a rollback: R2
// archival, D1 state, and a third-party email API cannot share a transaction,
// and a sent email cannot be recalled. So the sealed artifact is immutable and
// always survives; only the month-closed reporting state waits on delivery. A
// failed send leaves a visible, retryable `sealed_undelivered` state rather
// than destroying a valid seal. See docs/2026-06-pack-approved-delta.md §15 D2.
//
// CRITICAL: sealing and closing are different things. Edit-locking
// (loadSealedExportMonths, the finalized-reconciliation guard) is keyed on the
// SEAL and must never depend on delivery — if a failed send unlocked a sealed
// month its contents could change between attempts and a retry would send
// different bytes than the first attempt, silently. Seal locks edits; delivery
// closes the month for reporting.
//
// This module is PURE (no D1/R2) so the state-machine + idempotency logic is
// unit-testable without bindings. The DB wrappers live in db.ts.

/** Per-attempt outcome — one HTTP send to Resend = one row in export_deliveries. */
export const ATTEMPT_STATE = {
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
} as const;
export type AttemptState = (typeof ATTEMPT_STATE)[keyof typeof ATTEMPT_STATE];

/**
 * Denormalised per-month delivery state on receipt_exports (for list queries).
 * The latest operator-initiated send's result decides:
 *   delivered          — the latest send succeeded; the month is closed for reporting
 *   sealed_undelivered — the latest send failed; retryable, month NOT closed
 *   pending            — a send attempt is in flight
 *   NULL               — sealed, never sent (pre-Phase-B exports read NULL)
 */
export const DELIVERY_STATE = {
  DELIVERED: "delivered",
  SEALED_UNDELIVERED: "sealed_undelivered",
  PENDING: "pending",
} as const;
export type DeliveryState = (typeof DELIVERY_STATE)[keyof typeof DELIVERY_STATE];

/** Prefix for the Resend `Idempotency-Key` header. */
export const IDEMPOTENCY_KEY_PREFIX = "dazbeez-delivery-";

/**
 * The Resend idempotency key, derived from the attempt_id.
 *
 * B-3: a network timeout on the response is ambiguous — the mail may have been
 * accepted. The key is **stable across automatic retries of the same attempt**
 * (so a timeout-retry does not double-send) and **new for each operator-
 * initiated send**. It is never derived from the body — that would defeat the
 * double-send guard when bytes change between attempts.
 */
export function idempotencyKeyForAttempt(attemptId: string): string {
  return `${IDEMPOTENCY_KEY_PREFIX}${attemptId}`;
}

/**
 * The month delivery state that results from an attempt's outcome. The latest
 * operator-initiated send wins — a re-delivery (D17) supersedes the prior
 * pack, so a failed re-send puts a previously-delivered month back into
 * `sealed_undelivered` (the corrected pack did not arrive).
 */
export function deliveryStateForResult(result: AttemptState): DeliveryState {
  if (result === ATTEMPT_STATE.SENT) return DELIVERY_STATE.DELIVERED;
  if (result === ATTEMPT_STATE.FAILED) return DELIVERY_STATE.SEALED_UNDELIVERED;
  return DELIVERY_STATE.PENDING;
}

/**
 * Valid per-attempt state transitions. `pending → sent` and `pending → failed`
 * only; `sent` and `failed` are terminal. A retry is a NEW row sharing the
 * attempt_id (and idempotency key), not a transition out of a terminal state.
 */
export function isValidAttemptTransition(
  from: AttemptState,
  to: AttemptState,
): boolean {
  if (from === ATTEMPT_STATE.PENDING) {
    return to === ATTEMPT_STATE.SENT || to === ATTEMPT_STATE.FAILED;
  }
  return false;
}

/** A minimal attempt-row view for {@link deriveMonthDeliveryState}. */
export interface AttemptRow {
  attemptId: string;
  state: AttemptState;
  createdAt: string;
}

/**
 * Derive the month's delivery state from its attempt rows (a consistency check
 * for the denormalised column; the send path writes the column directly in the
 * same transaction).
 *
 * The latest operator-initiated send (the attempt_id owning the newest row)
 * decides: if any of its rows is `sent` → delivered; else if its newest row is
 * `failed` → sealed_undelivered; else `pending` (in flight).
 */
export function deriveMonthDeliveryState(
  attempts: AttemptRow[],
): DeliveryState | null {
  if (attempts.length === 0) return null;
  const newest = attempts.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const latestAttemptRows = attempts.filter((a) => a.attemptId === newest.attemptId);
  if (latestAttemptRows.some((a) => a.state === ATTEMPT_STATE.SENT)) {
    return DELIVERY_STATE.DELIVERED;
  }
  const latestRow = latestAttemptRows.reduce((a, b) =>
    b.createdAt > a.createdAt ? b : a,
  );
  if (latestRow.state === ATTEMPT_STATE.FAILED) {
    return DELIVERY_STATE.SEALED_UNDELIVERED;
  }
  return DELIVERY_STATE.PENDING;
}
