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
  classifyDeliveryFailure,
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

// ─── failure classification (false-negative duplicate-send guard) ───────────

test("classifyDeliveryFailure: explicit definitive allowlist (Resend 4xx); everything else ambiguous", () => {
  // Definitive: Resend responded 4xx — the request was rejected, mail never accepted.
  for (const s of [400, 401, 403, 422, 413, 499]) {
    assert.equal(classifyDeliveryFailure(s), "definitive", `${s} is definitive`);
  }
  // Ambiguous: 5xx (Resend server error), and any non-4xx response.
  for (const s of [500, 502, 503, 504, 200, 301, 399]) {
    assert.equal(classifyFailureAmbiguous(s), true, `${s} is ambiguous`);
  }
  // Ambiguous: no response at all (timeout / network error). Never infer "not sent".
  assert.equal(classifyDeliveryFailure(undefined), "ambiguous", "no response ⇒ ambiguous, never definitive");
});

function classifyFailureAmbiguous(status: number): boolean {
  return classifyDeliveryFailure(status) === "ambiguous";
}

// ─── result → month state ───────────────────────────────────────────────────

test("deliveryStateForResult: sent⇒delivered; failed OR ambiguous⇒sealed_undelivered; pending⇒pending", () => {
  assert.equal(deliveryStateForResult(ATTEMPT_STATE.SENT), DELIVERY_STATE.DELIVERED);
  assert.equal(deliveryStateForResult(ATTEMPT_STATE.FAILED), DELIVERY_STATE.SEALED_UNDELIVERED);
  assert.equal(deliveryStateForResult(ATTEMPT_STATE.AMBIGUOUS), DELIVERY_STATE.SEALED_UNDELIVERED);
  assert.equal(deliveryStateForResult(ATTEMPT_STATE.PENDING), DELIVERY_STATE.PENDING);
});

// ─── attempt state machine ──────────────────────────────────────────────────

test("isValidAttemptTransition: pending→sent/failed/ambiguous; sent/failed/ambiguous terminal", () => {
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.PENDING, ATTEMPT_STATE.SENT), true);
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.PENDING, ATTEMPT_STATE.FAILED), true);
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.PENDING, ATTEMPT_STATE.AMBIGUOUS), true);
  // terminal states can't transition out — a retry/resume is a NEW row sharing attempt_id
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.SENT, ATTEMPT_STATE.FAILED), false);
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.FAILED, ATTEMPT_STATE.SENT), false);
  assert.equal(isValidAttemptTransition(ATTEMPT_STATE.AMBIGUOUS, ATTEMPT_STATE.SENT), false);
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

test("decideSendAction: an ambiguous failure within 24h ⇒ resume (the mail may have been accepted)", () => {
  // sendViaResend timed out after Resend accepted ⇒ recorded ambiguous. A retry
  // must reuse the attempt_id so Resend deduplicates — not mint a new key.
  const res = decideSendAction({
    latestExportId: "exp",
    deliveries: [sum({ id: "d-amb", attemptId: "att-amb", state: ATTEMPT_STATE.AMBIGUOUS })],
    now: NOW,
    forceNew: false,
  });
  assert.equal(res.action, "resume");
  if (res.action === "resume") assert.equal(res.attemptId, "att-amb");
});

test("decideSendAction: a definitive failure (Resend 4xx) is neither resumeable nor a blocker ⇒ clean new send", () => {
  // Resend definitively rejected the request (4xx) ⇒ the mail was never accepted
  // ⇒ a retry is a fresh, safe attempt (new attempt_id), no override needed.
  const res = decideSendAction({
    latestExportId: "exp",
    deliveries: [sum({ attemptId: "att-rej", state: ATTEMPT_STATE.FAILED })],
    now: NOW,
    forceNew: false,
  });
  assert.equal(res.action, "new");
});

test("decideSendAction: a stale ambiguous failure (beyond 24h) blocks without override", () => {
  // Beyond the window Resend won't dedupe, so a fresh key risks a duplicate if
  // the first was accepted ⇒ override required.
  const staleAmbiguous = sum({ attemptId: "att-amb-old", state: ATTEMPT_STATE.AMBIGUOUS, createdAt: beyondWindow });
  assert.equal(
    decideSendAction({ latestExportId: "exp", deliveries: [staleAmbiguous], now: NOW, forceNew: false }).action,
    "blocked",
  );
  assert.equal(
    decideSendAction({ latestExportId: "exp", deliveries: [staleAmbiguous], now: NOW, forceNew: true }).action,
    "new",
  );
});

test("decideSendAction: ambiguous resumeable wins over an older definitive failure", () => {
  // First attempt rejected (4xx, failed); retry got an ambiguous result. Resume
  // the ambiguous attempt (its key dedupes); the definitive failure is ignored.
  const res = decideSendAction({
    latestExportId: "exp",
    deliveries: [
      sum({ id: "d-rej", attemptId: "att-rej", state: ATTEMPT_STATE.FAILED, createdAt: "2026-08-07T00:00:00Z" }),
      sum({ id: "d-amb", attemptId: "att-amb", state: ATTEMPT_STATE.AMBIGUOUS, createdAt: withinWindow }),
    ],
    now: NOW,
    forceNew: false,
  });
  assert.equal(res.action, "resume");
  if (res.action === "resume") assert.equal(res.attemptId, "att-amb");
});
