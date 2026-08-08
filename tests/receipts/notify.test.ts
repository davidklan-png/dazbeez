import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeNotifyTest,
  isValidDeliveryAddress,
  recipientSettingMessage,
  resolveNotificationRecipient,
  sendViaResend,
} from "@/lib/receipts/notify";

// ─── Recipient resolution (settings → fallback → null) ─────────────────────
test("resolveNotificationRecipient: settings value wins over fallback", () => {
  const r = resolveNotificationRecipient("manager@dazbeez.com", "fallback@dazbeez.com");
  assert.equal(r.email, "manager@dazbeez.com");
  assert.equal(r.source, "settings");
});

test("resolveNotificationRecipient: falls back to var when settings empty", () => {
  const r = resolveNotificationRecipient("", "admin@dazbeez.com");
  assert.equal(r.email, "admin@dazbeez.com");
  assert.equal(r.source, "fallback");
});

test("resolveNotificationRecipient: null when both unconfigured", () => {
  const r = resolveNotificationRecipient("", null);
  assert.equal(r.email, null);
  assert.equal(r.source, null);
});

// ─── isValidDeliveryAddress (Change 5 — validate both addrs before the send) ─
test("isValidDeliveryAddress: accepts well-formed addresses (whitespace trimmed)", () => {
  assert.equal(isValidDeliveryAddress("cpa@example.com"), true);
  assert.equal(isValidDeliveryAddress("a.b+tag@sub.example.co.jp"), true);
  assert.equal(isValidDeliveryAddress("  ops@dazbeez.com \t"), true, "leading/trailing ws trimmed");
});

test("isValidDeliveryAddress: rejects malformed addresses (would be a definitive Resend 4xx)", () => {
  for (const bad of [
    "", "   ", "no-at-sign", "no@dot", "@nodomain.com", "nolocal@",
    "a @b.com", "a@b com", "plainstring",
  ]) {
    assert.equal(isValidDeliveryAddress(bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

// ─── recipientSettingMessage (D7 — actual behavior, NOT auto-on-finalize) ─────
test("recipientSettingMessage: describes operator-sent delivery, not auto-on-finalize; is audited", () => {
  for (const field of ["notification_recipient", "notification_cc_recipient"] as const) {
    const msg = recipientSettingMessage(field);
    assert.ok(msg.length > 0, field);
    // Actual behavior: the pack is sent BY THE OPERATOR (explicit send action).
    assert.ok(msg.includes("オペレーターによって送信"), `${field}: names operator-initiated send`);
    // The pre-decoupling D7 claim ("auto-sent on finalize") is now FALSE — the
    // message must negate it, never assert it.
    assert.ok(msg.includes("自動送信は行われません"), `${field}: negates auto-on-finalize`);
    assert.ok(!/確定.*自動送信され(る|ます)/.test(msg), `${field}: must not claim auto-send on finalize`);
    // The field is audited.
    assert.ok(msg.includes("監査ログ"), `${field}: mentions audit`);
  }
});

test("recipientSettingMessage: To vs Cc wording differs by role", () => {
  assert.ok(recipientSettingMessage("notification_recipient").includes("送信先（To）"));
  assert.ok(recipientSettingMessage("notification_cc_recipient").includes("CC（写先行）"));
});

// ─── sendViaResend (isolated seam — mock fetch) ─────────────────────────────
/** Capturing fetch stub standing in for the Resend transport. */
function fakeResend(response: { ok: true } | { ok: false; status: number; message?: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response.ok) return { ok: true, status: 200, json: async () => ({ id: "x" }) } as Response;
    return { ok: false, status: response.status, json: async () => ({ message: response.message ?? "boom" }) } as Response;
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

test("sendViaResend: {ok:true} on 200", async () => {
  const { fetchImpl } = fakeResend({ ok: true });
  const res = await sendViaResend(fetchImpl, "key", "from@d.com", "to@d.com", "subj", "text", "<p>html</p>");
  assert.equal(res.ok, true);
});

test("sendViaResend: non-2xx → {ok:false} with Resend error message verbatim", async () => {
  const { fetchImpl } = fakeResend({ ok: false, status: 422, message: "The `from` address is not verified" });
  const res = await sendViaResend(fetchImpl, "key", "bad@d.com", "to@d.com", "subj", "text", "<p>html</p>");
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /from.*not verified/);
});

test("sendViaResend: network error → {ok:false} without throwing", async () => {
  const throwingFetch = async () => { throw new Error("network down"); };
  const res = await sendViaResend(throwingFetch as unknown as typeof fetch, "key", "from@d.com", "to@d.com", "subj", "text", "<p>html</p>");
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /network down/);
});

test("sendViaResend: cc passed → [cc] in the body; cc omitted/null → field absent (channel-probe Cc)", async () => {
  // with Cc
  const a = fakeResend({ ok: true });
  await sendViaResend(a.fetchImpl, "key", "from@d.com", "to@d.com", "subj", "text", "<p>html</p>", "ops@dazbeez.com");
  const bodyA = JSON.parse(a.calls[0]!.init.body as string);
  assert.deepEqual(bodyA.cc, ["ops@dazbeez.com"]);

  // without Cc (default null) — field omitted entirely, never cc:null/cc:""
  const b = fakeResend({ ok: true });
  await sendViaResend(b.fetchImpl, "key", "from@d.com", "to@d.com", "subj", "text", "<p>html</p>");
  const bodyB = JSON.parse(b.calls[0]!.init.body as string);
  assert.equal(bodyB.cc, undefined, "unset Cc ⇒ field absent from the payload");
});

// ─── authorizeNotifyTest (Clerk-only — processor-key rejected) ──────────────
test("authorizeNotifyTest: rejects null (processor-key-only / no session)", () => {
  assert.throws(() => authorizeNotifyTest(null), /Unauthorized/);
});

test("authorizeNotifyTest: accepts a Clerk actor", () => {
  assert.equal(authorizeNotifyTest("op@dazbeez.com"), "op@dazbeez.com");
});
