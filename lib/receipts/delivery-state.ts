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

/** The pill/colour discriminant for a month's delivery state (delivery-composer
 *  §6 table). Pure + client-safe (this module has no D1/R2 imports) so the shared
 *  MonthSwitcher component and the server helper in delivery-status.ts both
 *  import it from here — one mapping authority, no drift. */
export type DeliveryPillState = "delivered" | "pending" | "undelivered";

/** Map a month's derived delivery state to its pill tone. `delivered` → green ✓,
 *  `pending` → blue (in-flight), and BOTH `sealed_undelivered` (failed) AND null
 *  (sealed, never attempted) → `undelivered` (red). The null→undelivered mapping
 *  is the whole point: a sealed-but-never-sent month must read as action-needed
 *  red, not neutral grey. */
export function deliveryStateToPill(
  state: DeliveryState | null | undefined,
): DeliveryPillState {
  if (state === DELIVERY_STATE.DELIVERED) return "delivered";
  if (state === DELIVERY_STATE.PENDING) return "pending";
  return "undelivered";
}

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
 *  - `new`: nothing delivered for this month — start a fresh attempt (new attempt_id).
 *  - `resume`: a resumeable attempt exists for the CURRENT revision (pending, or
 *    an ambiguous failure within the window) — reuse its attempt_id so Resend
 *    replays (no duplicate). Distinct from a new send; no override needed.
 *  - `redelivery`: a DIFFERENT, earlier revision has an attempt whose mail MAY
 *    have reached the accountant (sent / pending / ambiguous — anything but a
 *    definitive `failed`), and the current revision has no such attempt. This is
 *    the FIRST send of the current revision — legitimate, not a duplicate of the
 *    current pack. Needs an explicit UI confirmation (the accountant may receive
 *    a second email) but NOT force_new, and it audits as a re-delivery, not an
 *    override. Carries the prior attempt id + its state, because the composer
 *    copy must not claim the earlier pack WAS delivered when the evidence is
 *    only pending/ambiguous.
 *  - `blocked`: the CURRENT revision (latestExportId) was already delivered
 *    (`sent`), OR has a pending/ambiguous attempt that is NOT resumeable (stale
 *    beyond the 24h window) — a new send risks a duplicate of THIS revision's
 *    pack, so it needs the explicit override (forceNew).
 *
 *  State and action are scoped to the latest finalized revision; month-wide
 *  delivery history is still consulted to tell `redelivery` (an earlier
 *  revision's sent / pending / ambiguous) apart from `blocked` (a `sent` for
 *  this one). A definitive `failed` attempt is neither resumeable nor a
 *  redelivery signal nor a blocker — Resend definitively rejected it, so the
 *  accountant never received it and a retry is a clean new send. */
export type SendAction =
  | { action: "new" }
  | {
      action: "redelivery";
      priorAttemptId: string;
      /** The prior (earlier-revision) attempt's state. `sent` ⇒ the earlier pack
       *  was delivered; `pending`/`ambiguous` ⇒ it may have been. The composer
       *  copy branches on this so it never overclaims delivery. */
      priorAttemptState: AttemptState;
    }
  | { action: "resume"; attemptId: string; deliveryId: string }
  | { action: "blocked"; reason: "sent" | "stale"; priorAttemptId: string };

/** States that are resumeable when fresh: in-flight (`pending`) or a false-
 *  negative failure (`ambiguous` — the mail may have been accepted). */
const RESUMEABLE_STATES = [ATTEMPT_STATE.PENDING, ATTEMPT_STATE.AMBIGUOUS] as const;

/** Attempt states in which the accountant MAY already hold a pack for the
 *  attempt's revision: `sent` (definitely delivered) plus the resumeable states
 *  `pending` (in flight) / `ambiguous` (false-negative — may have been
 *  accepted). `failed` is definitive rejection — never accepted, so the
 *  accountant does not have it. This is the predicate for
 *  {@link SendAction.redelivery} on an EARLIER revision: any of these means
 *  sending the current revision produces a second email, which `redelivery`
 *  exists to make explicit.
 *
 *  The 24h idempotency window is IRRELEVANT here — resumability is about whether
 *  Resend will dedupe a retry of the SAME pack; this is a different pack, so
 *  window state does not change whether the accountant already got mail. Derived
 *  from {@link RESUMEABLE_STATES} + SENT rather than spelling the set out again.
 *
 *  Exported because it is also the doctrine for sealed-export DELETION: a month
 *  whose pack may have reached the accountant (any of these states) must not be
 *  deletable — deleting destroys the only record of what was sent. The next
 *  consumer reuses the constant rather than re-spelling the set. */
export const MAY_HAVE_REACHED_RECIPIENT_STATES = [...RESUMEABLE_STATES, ATTEMPT_STATE.SENT] as const;

/** Is `d` a resumeable attempt for the CURRENT revision — pending or ambiguous,
 *  for this export, still inside Resend's 24h idempotency window? A resume
 *  reuses its attempt_id ⇒ same key ⇒ Resend replays, so no duplicate send. */
function isResumeableDelivery(
  d: DeliveryAttemptSummary,
  latestExportId: string,
  now: string,
): boolean {
  return (
    d.exportId === latestExportId &&
    (RESUMEABLE_STATES as readonly AttemptState[]).includes(d.state) &&
    isWithinResumeWindow(d.createdAt, now)
  );
}

/** The duplicate-send blocker for the CURRENT revision (latestExportId), or
 *  null. Two shapes, both scoped to this revision on purpose:
 *   - `sent`: this revision's pack already landed — a genuine duplicate.
 *   - `stale`: a pending/ambiguous for this revision that is no longer
 *     resumeable (beyond 24h) — Resend won't dedupe a fresh key, so a new send
 *     risks duplicating THIS revision's pack.
 *  A `sent` or stale pending for an EARLIER revision is intentionally NOT a
 *  blocker here: it is a different pack, so it is a {@link SendAction.redelivery}
 *  signal (or irrelevant), not a duplicate of the current one.
 *
 *  Shared by {@link decideSendAction} (the block decision) and the send route
 *  (the force_new-override audit) so the two cannot drift on what "blocker"
 *  means — the one-authority pattern this module uses throughout. */
export function findRevisionSendBlocker(
  deliveries: DeliveryAttemptSummary[],
  latestExportId: string,
  now: string,
): { reason: "sent" | "stale"; priorAttemptId: string } | null {
  const sent = deliveries.find(
    (d) => d.exportId === latestExportId && d.state === ATTEMPT_STATE.SENT,
  );
  if (sent) return { reason: "sent", priorAttemptId: sent.attemptId };
  const stale = deliveries.find(
    (d) =>
      d.exportId === latestExportId &&
      (RESUMEABLE_STATES as readonly AttemptState[]).includes(d.state) &&
      !isResumeableDelivery(d, latestExportId, now),
  );
  if (stale) return { reason: "stale", priorAttemptId: stale.attemptId };
  return null;
}

/**
 * Decide new vs resume vs redelivery vs blocked for a send request. Pure — the
 * send endpoint supplies `now`, the latest export id, and the month's delivery
 * rows (across ALL revisions — month-wide history is kept so an earlier
 * revision's `sent` can be recognised as a re-delivery rather than a block).
 *
 * STATE and ACTION are scoped to the latest finalized revision: a `sent` or
 * stale-pending for THIS revision blocks (genuine duplicate of the current
 * pack); an earlier revision's sent / pending / ambiguous is a `redelivery` —
 * the first send of the current revision, legitimate, needing UI confirmation
 * but not force_new (the accountant may already hold the earlier pack). This is
 * the fix for the month-wide `sent` lookups that made a corrected-but-unsent
 * revision read as delivered (display) and forced the operator through force_new
 * for its FIRST send (send path, audited as an override).
 *
 * Resume (pending/ambiguous, this revision, within 24h) wins first — a
 * corrected re-delivery in flight supersedes a prior delivered pack. forceNew
 * skips resume and overrides a block (the caller audits the override via
 * {@link findRevisionSendBlocker}); a redundant forceNew on a redelivery still
 * returns `redelivery` (it never audits as an override). A definitive `failed`
 * attempt blocks nothing — a retry is a fresh, safe send.
 */
export function decideSendAction(opts: {
  latestExportId: string;
  deliveries: DeliveryAttemptSummary[];
  now: string;
  forceNew: boolean;
}): SendAction {
  const { latestExportId, deliveries, now, forceNew } = opts;

  const resumeable = deliveries.find((d) =>
    isResumeableDelivery(d, latestExportId, now),
  );
  if (resumeable && !forceNew) {
    return { action: "resume", attemptId: resumeable.attemptId, deliveryId: resumeable.id };
  }

  const blocker = findRevisionSendBlocker(deliveries, latestExportId, now);
  if (blocker) {
    // forceNew overrides the duplicate guard for THIS revision — proceed as a
    // fresh send; the caller audits it as an override via findRevisionSendBlocker.
    // (Return before the redelivery check: a sent-for-this-revision override is
    // NOT a redelivery, even if an earlier revision was also delivered.)
    if (forceNew) return { action: "new" };
    return {
      action: "blocked",
      reason: blocker.reason,
      priorAttemptId: blocker.priorAttemptId,
    };
  }

  // No blocker for the current revision. An EARLIER-revision attempt whose mail
  // MAY have reached the accountant (sent / pending / ambiguous — anything but a
  // definitive `failed`) means this is the first send of the current revision
  // and the accountant may already hold an earlier pack: a legitimate re-delivery
  // requiring UI confirmation, not a duplicate and not an override. The 24h
  // window does not enter in — a different pack, so Resend dedupe is irrelevant.
  const earlierMayHaveReached = deliveries.filter(
    (d) =>
      d.exportId !== latestExportId &&
      (MAY_HAVE_REACHED_RECIPIENT_STATES as readonly AttemptState[]).includes(d.state),
  );
  if (earlierMayHaveReached.length > 0) {
    // If several qualify, prefer `sent` (definitive) over pending/ambiguous so
    // the audit and the UI name the strongest evidence.
    const prior =
      earlierMayHaveReached.find((d) => d.state === ATTEMPT_STATE.SENT) ??
      earlierMayHaveReached[0]!;
    return {
      action: "redelivery",
      priorAttemptId: prior.attemptId,
      priorAttemptState: prior.state,
    };
  }

  return { action: "new" };
}
