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

/** Per-attempt outcome — one HTTP send to Resend = one row in export_deliveries.
 *
 *  `ambiguous` is the false-negative counterpart to `pending`: the Worker got
 *  neither a clear success nor a definitive rejection (timeout, network error,
 *  Resend 5xx, no response) — the mail may have been accepted. Like `pending`
 *  it is RESUMABLE (a retry reuses the attempt_id so Resend deduplicates),
 *  never treated as "definitely not sent". */
export const ATTEMPT_STATE = {
  PENDING: "pending",
  SENT: "sent",
  FAILED: "failed",
  AMBIGUOUS: "ambiguous",
} as const;
export type AttemptState = (typeof ATTEMPT_STATE)[keyof typeof ATTEMPT_STATE];

/** How a delivery failure should be treated. Definitive = Resend definitively
 *  rejected it (4xx) — the mail was never accepted, a fresh attempt is safe.
 *  Ambiguous = 5xx / network / timeout / no response — the mail may have been
 *  accepted, so the attempt stays resumable. */
export type DeliveryFailureClass = "definitive" | "ambiguous";

/**
 * Classify a delivery failure. Explicit allowlist of DEFINITIVE conditions —
 * Resend returned a 4xx (the request was definitively rejected; the mail was
 * never accepted) — defaulting to AMBIGUOUS (5xx, network error, timeout, no
 * response: the mail may have been accepted). Never infer "definitely not sent"
 * from the absence of a response. Same doctrine as the consumer's permanent-
 * vs-transient classification (backlog #9).
 *
 * `status` is the Resend HTTP status when it responded; `undefined` for a
 * transport error / timeout / no response.
 */
export function classifyDeliveryFailure(status: number | undefined): DeliveryFailureClass {
  if (status !== undefined && status >= 400 && status < 500) {
    return "definitive";
  }
  return "ambiguous";
}

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
  // Both definitive-failed and ambiguous mean the month is not confirmed
  // delivered → sealed_undelivered (retryable). The difference (resumable vs
  // not) lives on the attempt row's state, not the month-level column.
  if (result === ATTEMPT_STATE.FAILED || result === ATTEMPT_STATE.AMBIGUOUS) {
    return DELIVERY_STATE.SEALED_UNDELIVERED;
  }
  return DELIVERY_STATE.PENDING;
}

/**
 * Valid per-attempt state transitions. `pending` may resolve to `sent`,
 * `failed` (definitive rejection), or `ambiguous` (timeout/5xx — the mail may
 * have been accepted). `sent`, `failed`, and `ambiguous` are terminal for that
 * row — a retry/resume is a NEW row sharing the attempt_id (and idempotency
 * key), not a transition out of a terminal state.
 */
export function isValidAttemptTransition(
  from: AttemptState,
  to: AttemptState,
): boolean {
  if (from === ATTEMPT_STATE.PENDING) {
    return (
      to === ATTEMPT_STATE.SENT ||
      to === ATTEMPT_STATE.FAILED ||
      to === ATTEMPT_STATE.AMBIGUOUS
    );
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
  if (
    latestRow.state === ATTEMPT_STATE.FAILED ||
    latestRow.state === ATTEMPT_STATE.AMBIGUOUS
  ) {
    return DELIVERY_STATE.SEALED_UNDELIVERED;
  }
  return DELIVERY_STATE.PENDING;
}

// ─── Resume vs new send (the stuck-pending duplicate-send guard) ─────────────
//
// If the Worker dies after Resend accepts but before markDeliverySent, the
// attempt row stays `pending`. A naive retry that created a NEW attempt_id +
// key would double-send (the guard can't tell the first was accepted). So a
// `pending` attempt is RESUMED — the next send reuses its attempt_id, hence
// the same idempotency key, and Resend replays the original result. This is
// distinct from starting a fresh send (new attempt_id), which the double-send
// guard blocks unless the caller passes an explicit override.
//
// Resend's idempotency window is ~24h. Within it a resume replays; beyond it
// Resend will not recognise the key, so a "resume" is a genuine second send —
// the pending is then stale and a new send requires the override.

/** Resend's idempotency window. A resume is only safe within it. */
export const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Is a pending attempt still within Resend's idempotency window (resumeable)?
 *  Both args are ISO strings; `now` is passed in so the check is deterministic
 *  and unit-testable. */
export function isWithinResumeWindow(pendingCreatedAt: string, now: string): boolean {
  return Date.parse(now) - Date.parse(pendingCreatedAt) <= RESEND_IDEMPOTENCY_WINDOW_MS;
}

/** A delivery-row view for {@link decideSendAction}. */
export interface DeliveryAttemptSummary {
  id: string;
  exportId: string;
  attemptId: string;
  state: AttemptState;
  createdAt: string;
}

/** What the send endpoint should do for a month, given its delivery history.
 *  - `new`: no blocking delivery — start a fresh attempt (new attempt_id).
 *  - `resume`: a resumeable attempt exists (pending, or an ambiguous failure
 *    within the window) — reuse its attempt_id so Resend replays (no duplicate).
 *    Distinct from a new send; no override needed.
 *  - `blocked`: a `sent` delivery exists, OR a pending/ambiguous attempt that
 *    is NOT resumeable (stale beyond the window, or for a different export) —
 *    a new send risks a duplicate, so it needs the explicit override (forceNew).
 *
 *  A definitive-`failed` attempt is neither resumeable nor a blocker — Resend
 *  definitively rejected it, so a retry is a clean new send. */
export type SendAction =
  | { action: "new" }
  | { action: "resume"; attemptId: string; deliveryId: string }
  | {
      action: "blocked";
      reason: "sent" | "stale";
      priorAttemptId: string;
    };

/**
 * Decide new vs resume vs blocked for a send request. Pure — the send endpoint
 * supplies `now`, the latest export id, and the month's delivery rows.
 *
 * Resume states are `pending` (in flight) and `ambiguous` (false-negative
 * failure — the mail may have been accepted). A resumeable attempt (latest
 * export, within the 24h idempotency window) resumes (unless forceNew) even if
 * an older export was sent (a corrected re-delivery in flight supersedes it).
 * A `sent` delivery or a stale/other-export pending-or-ambiguous blocks a new
 * send (duplicate risk) unless forceNew. A definitive `failed` attempt blocks
 * nothing — a retry is a fresh, safe send.
 */
export function decideSendAction(opts: {
  latestExportId: string;
  deliveries: DeliveryAttemptSummary[];
  now: string;
  forceNew: boolean;
}): SendAction {
  const { latestExportId, deliveries, now, forceNew } = opts;

  const RESUMABLE = [ATTEMPT_STATE.PENDING, ATTEMPT_STATE.AMBIGUOUS] as const;
  const isResumeable = (d: DeliveryAttemptSummary) =>
    d.exportId === latestExportId &&
    (RESUMABLE as readonly AttemptState[]).includes(d.state) &&
    isWithinResumeWindow(d.createdAt, now);

  const resumeable = deliveries.find(isResumeable);
  if (resumeable && !forceNew) {
    return { action: "resume", attemptId: resumeable.attemptId, deliveryId: resumeable.id };
  }

  const sent = deliveries.find((d) => d.state === ATTEMPT_STATE.SENT);
  // A pending/ambiguous that is NOT resumeable (stale beyond 24h, or for a
  // different export) blocks a new send — beyond the window Resend will not
  // deduplicate, so a fresh key risks a duplicate if the first was accepted.
  const stale = deliveries.find(
    (d) =>
      (RESUMABLE as readonly AttemptState[]).includes(d.state) && !isResumeable(d),
  );
  if ((sent || stale) && !forceNew) {
    const blocker = sent ?? stale!;
    return {
      action: "blocked",
      reason: sent ? "sent" : "stale",
      priorAttemptId: blocker.attemptId,
    };
  }

  return { action: "new" };
}
