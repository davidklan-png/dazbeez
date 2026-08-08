import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTEMPT_STATE,
  DELIVERY_STATE,
  IDEMPOTENCY_KEY_PREFIX,
  RESEND_IDEMPOTENCY_WINDOW_MS,
  idempotencyKeyForAttempt,
  deliveryStateForResult,
  isValidAttemptTransition,
  deriveMonthDeliveryState,
  isWithinResumeWindow,
  decideSendAction,
  type AttemptRow,
  type DeliveryAttemptSummary,
} from "@/lib/receipts/delivery-state";

// ─── idempotency key (B-3) ──────────────────────────────────────────────────

test("idempotencyKeyForAttempt: stable per attempt, new per operator send, prefixed", () => {
  const k1 = idempotencyKeyForAttempt("att-1");
  assert.equal(k1, idempotencyKeyForAttempt("att-1"), "same attempt_id ⇒ same key (stable across retries)");
  assert.notEqual(k1, idempotencyKeyForAttempt("att-2"), "different attempt_id ⇒ different key (new per send)");
  assert.equal(k1, `${IDEMPOTENCY_KEY_PREFIX}att-1`);
  // Never derived from the body: identical attempt_id ⇒ identical key regardless
  // of what bytes are being sent (a body-derived key would defeat the D6 guard).
  assert.equal(idempotencyKeyForAttempt("att-1"), idempotencyKeyForAttempt("att-1"));
});

// ─── result → month state ───────────────────────────────────────────────────

test("deliveryStateForResult: sent⇒delivered, failed⇒sealed_undelivered, pending⇒pending", () => {
  assert.equal(deliveryStateForResult(ATTEMPT_STATE.SENT), DELIVERY_STATE.DELIVERED);
  assert.equal(deliveryStateForResult(ATTEMPT_STATE.FAILED), DELIVERY_STATE.SEALED_UNDELIVERED);
  assert.equal(deliveryStateForResult(ATTEMPT_STATE.PENDING), DELIVERY_STATE.PENDING);
});

// ─── attempt state machine ──────────────────────────────────────────────────

test("isValidAttemptTransition: only pending→sent / pending→failed; sent & failed are terminal", () => {
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.PENDING, ATTEMPT_STATE.SENT), true);
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.PENDING, ATTEMPT_STATE.FAILED), true);
  // terminal states can't transition out — a retry is a NEW row sharing attempt_id
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.SENT, ATTEMPT_STATE.FAILED), false);
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.FAILED, ATTEMPT_STATE.SENT), false);
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.SENT, ATTEMPT_STATE.SENT), false);
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.PENDING, ATTEMPT_STATE.PENDING), false);
});

// ─── month-state derivation (denormalised column consistency) ────────────────

test("deriveMonthDeliveryState: empty⇒null; a single attempt's outcome", () => {
  const t = "2026-08-08T00:00:00Z";
  assert.equal(deriveMonthDeliveryState([]), null);
  assert.equal(
    deriveMonthDeliveryState([{ attemptId: "a", state: ATTEMPT_STATE.SENT, createdAt: t }]),
    DELIVERY_STATE.DELIVERED,
  );
  assert.equal(
    deriveMonthDeliveryState([{ attemptId: "a", state: ATTEMPT_STATE.FAILED, createdAt: t }]),
    DELIVERY_STATE.SEALED_UNDELIVERED,
  );
  assert.equal(
    deriveMonthDeliveryState([{ attemptId: "a", state: ATTEMPT_STATE.PENDING, createdAt: t }]),
    DELIVERY_STATE.PENDING,
  );
});

test("deriveMonthDeliveryState: a sent retry of an attempt ⇒ delivered even if an earlier row failed", () => {
  const rows: AttemptRow[] = [
    { attemptId: "a", state: ATTEMPT_STATE.FAILED, createdAt: "2026-08-08T00:00:00Z" },
    { attemptId: "a", state: ATTEMPT_STATE.SENT, createdAt: "2026-08-08T00:01:00Z" },
  ];
  assert.equal(deriveMonthDeliveryState(rows), DELIVERY_STATE.DELIVERED);
});

test("deriveMonthDeliveryState: the latest operator send wins — a failed re-delivery supersedes a prior success", () => {
  // First send succeeded; a corrected re-delivery (new attempt_id) then failed.
  // The corrected pack did not arrive, so the month is NOT closed — even though
  // the original pack landed. (D17 re-delivery semantics.)
  const failedRedelivery: AttemptRow[] = [
    { attemptId: "att-1", state: ATTEMPT_STATE.SENT, createdAt: "2026-08-08T00:00:00Z" },
    { attemptId: "att-2", state: ATTEMPT_STATE.FAILED, createdAt: "2026-08-08T01:00:00Z" },
  ];
  assert.equal(
    deriveMonthDeliveryState(failedRedelivery),
    DELIVERY_STATE.SEALED_UNDELIVERED,
    "failed re-delivery ⇒ sealed_undelivered, even though the prior pack landed",
  );
  // And a successful re-delivery ⇒ delivered.
  const okRedelivery: AttemptRow[] = [
    { attemptId: "att-1", state: ATTEMPT_STATE.FAILED, createdAt: "2026-08-08T00:00:00Z" },
    { attemptId: "att-2", state: ATTEMPT_STATE.SENT, createdAt: "2026-08-08T01:00:00Z" },
  ];
  assert.equal(deriveMonthDeliveryState(okRedelivery), DELIVERY_STATE.DELIVERED);
});

// ─── resume window + decideSendAction (stuck-pending duplicate-send guard) ──

const NOW = "2026-08-08T12:00:00.000Z";
const withinWindow = new Date(Date.parse(NOW) - 60 * 60 * 1000).toISOString(); // 1h ago
const beyondWindow = new Date(Date.parse(NOW) - RESEND_IDEMPOTENCY_WINDOW_MS - 1).toISOString();

test("isWithinResumeWindow: within 24h ⇒ true; beyond ⇒ false; boundary inclusive", () => {
  assert.equal(isWithinResumeWindow(withinWindow, NOW), true);
  assert.equal(isWithinResumeWindow(beyondWindow, NOW), false);
  // exactly at the window edge ⇒ still resumeable (≤)
  const edge = new Date(Date.parse(NOW) - RESEND_IDEMPOTENCY_WINDOW_MS).toISOString();
  assert.equal(isWithinResumeWindow(edge, NOW), true);
});

function sum(over: Partial<DeliveryAttemptSummary>): DeliveryAttemptSummary {
  return {
    id: "d1", exportId: "exp", attemptId: "att-1", state: ATTEMPT_STATE.PENDING, createdAt: withinWindow,
    ...over,
  };
}

test("decideSendAction: no deliveries ⇒ new", () => {
  assert.deepEqual(
    decideSendAction({ latestExportId: "exp", deliveries: [], now: NOW, forceNew: false }),
    { action: "new" },
  );
});

test("decideSendAction: a resumeable pending (latest export, within window) ⇒ resume, reusing attempt_id", () => {
  const res = decideSendAction({
    latestExportId: "exp",
    deliveries: [sum({ id: "d9", attemptId: "att-9" })],
    now: NOW,
    forceNew: false,
  });
  assert.equal(res.action, "resume");
  if (res.action === "resume") {
    assert.equal(res.attemptId, "att-9", "reuses the pending attempt_id (same idempotency key ⇒ Resend replays)");
    assert.equal(res.deliveryId, "d9");
  }
});

test("decideSendAction: resumeable pending + forceNew ⇒ new (override skips the resume)", () => {
  const res = decideSendAction({
    latestExportId: "exp",
    deliveries: [sum({ attemptId: "att-9" })],
    now: NOW,
    forceNew: true,
  });
  assert.equal(res.action, "new");
});

test("decideSendAction: a sent delivery blocks a new send without override", () => {
  const res = decideSendAction({
    latestExportId: "exp",
    deliveries: [sum({ state: ATTEMPT_STATE.SENT, attemptId: "att-old" })],
    now: NOW,
    forceNew: false,
  });
  assert.equal(res.action, "blocked");
  if (res.action === "blocked") {
    assert.equal(res.reason, "sent");
    assert.equal(res.priorAttemptId, "att-old");
  }
});

test("decideSendAction: a stale pending (beyond 24h) blocks without override; override ⇒ new", () => {
  const stale = sum({ attemptId: "att-stale", createdAt: beyondWindow });
  assert.equal(
    decideSendAction({ latestExportId: "exp", deliveries: [stale], now: NOW, forceNew: false }).action,
    "blocked",
  );
  assert.equal(
    decideSendAction({ latestExportId: "exp", deliveries: [stale], now: NOW, forceNew: true }).action,
    "new",
  );
});

test("decideSendAction: a pending for a DIFFERENT export is not resumeable ⇒ blocks without override", () => {
  const otherExport = sum({ exportId: "exp-old", attemptId: "att-other" });
  const res = decideSendAction({
    latestExportId: "exp",
    deliveries: [otherExport],
    now: NOW,
    forceNew: false,
  });
  assert.equal(res.action, "blocked");
});

test("decideSendAction: a resumeable pending supersedes an older sent (corrected re-delivery in flight)", () => {
  // Old pack sent (delivered); a corrected re-delivery is in flight (pending, latest export).
  // Resume the pending (corrected pack), not block on the old sent.
  const res = decideSendAction({
    latestExportId: "exp-v2",
    deliveries: [
      sum({ id: "d-old", exportId: "exp-v1", attemptId: "att-old", state: ATTEMPT_STATE.SENT }),
      sum({ id: "d-new", exportId: "exp-v2", attemptId: "att-new", state: ATTEMPT_STATE.PENDING }),
    ],
    now: NOW,
    forceNew: false,
  });
  assert.equal(res.action, "resume");
  if (res.action === "resume") assert.equal(res.attemptId, "att-new");
});
