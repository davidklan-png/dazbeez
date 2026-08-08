import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DELIVERY_ZIP_BYTES,
  assertDeliverySize,
  assertDeliveryZipNameAscii,
  bytesToBase64,
  performDelivery,
} from "@/lib/receipts/delivery-send";

// ─── B-1 size ceiling ───────────────────────────────────────────────────────

test("assertDeliverySize: under/at the ceiling is fine; over throws with the real numbers", () => {
  assert.doesNotThrow(() => assertDeliverySize(0));
  assert.doesNotThrow(() => assertDeliverySize(MAX_DELIVERY_ZIP_BYTES));
  assert.throws(
    () => assertDeliverySize(MAX_DELIVERY_ZIP_BYTES + 1),
    /exceeds the .* delivery ceiling/,
  );
  // the error names the actual byte count and the ceiling (digits only — the
  // message groups with toLocaleString, whose separators are locale-dependent)
  try {
    assertDeliverySize(MAX_DELIVERY_ZIP_BYTES + 1234);
    assert.fail("should have thrown");
  } catch (e) {
    const msgDigits = String(e).replace(/\D/g, "");
    const onlyDigits = (n: number) => String(n);
    assert.ok(msgDigits.includes(onlyDigits(MAX_DELIVERY_ZIP_BYTES + 1234)), "names the actual byte count");
    assert.ok(msgDigits.includes(onlyDigits(MAX_DELIVERY_ZIP_BYTES)), "names the ceiling");
  }
});

// ─── B-4 attachment filename ASCII ──────────────────────────────────────────

test("assertDeliveryZipNameAscii: ASCII ok; non-ASCII throws", () => {
  assert.doesNotThrow(() => assertDeliveryZipNameAscii("202606_Dazbeez_Monthly_Expense_Report.zip"));
  assert.throws(
    () => assertDeliveryZipNameAscii("202606_領収書.zip"),
    /must be pure ASCII/,
  );
});

// ─── base64 helper ──────────────────────────────────────────────────────────

test("bytesToBase64: round-trips raw bytes", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0xff]);
  const b64 = bytesToBase64(bytes);
  assert.equal(b64, btoa(String.fromCharCode(...bytes)));
  // decode back
  const decoded = Uint8Array.from(Buffer.from(b64, "base64"));
  assert.deepEqual([...decoded], [...bytes]);
});

// ─── performDelivery: boundary order + idempotency + attachment (B-1/B-3/B-4) ─

/** Capturing fetch stub standing in for the Resend transport. */
function fakeResend(response: { ok: true; id?: string } | { ok: false; status: number }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response.ok) {
      return { ok: true, status: 200, json: async () => ({ id: response.id ?? "msg-1" }) } as Response;
    }
    return { ok: false, status: response.status, json: async () => ({ message: "boom" }) } as Response;
  };
  return { fetchImpl, calls };
}

test("performDelivery: success records the provider message id; sends Idempotency-Key + attachment", async () => {
  const { fetchImpl, calls } = fakeResend({ ok: true, id: "resend-msg-42" });
  const r = await performDelivery({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: "key", from: "from@dazbeez.com", to: "cpa@example.com", cc: "ops@dazbeez.com",
    subject: "【領収証憑】2026年6月分 確定通知", text: "body", html: "<p>body</p>",
    zipFilename: "202606_Dazbeez_Monthly_Expense_Report.zip",
    zipBytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    idempotencyKey: "dazbeez-delivery-att-1",
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.messageId, "resend-msg-42");
  assert.equal(calls.length, 1, "exactly one Resend call");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Idempotency-Key"], "dazbeez-delivery-att-1", "B-3: key on the request header");
  assert.equal(headers["Authorization"], "Bearer key");
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.deepEqual(body.to, ["cpa@example.com"]);
  assert.deepEqual(body.cc, ["ops@dazbeez.com"]);
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].filename, "202606_Dazbeez_Monthly_Expense_Report.zip");
});

test("performDelivery: an oversized pack throws BEFORE any Resend call (B-1)", async () => {
  const { fetchImpl, calls } = fakeResend({ ok: true });
  await assert.rejects(
    () =>
      performDelivery({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        apiKey: "key", from: "f", to: "t", cc: null, subject: "s", text: "t", html: "h",
        zipFilename: "pack.zip",
        zipBytes: new Uint8Array(MAX_DELIVERY_ZIP_BYTES + 1),
        idempotencyKey: "k",
      }),
    /delivery ceiling/,
  );
  assert.equal(calls.length, 0, "no Resend call when over the size ceiling");
});

test("performDelivery: a non-ASCII attachment filename throws BEFORE any Resend call (B-4)", async () => {
  const { fetchImpl, calls } = fakeResend({ ok: true });
  await assert.rejects(
    () =>
      performDelivery({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        apiKey: "key", from: "f", to: "t", cc: null, subject: "s", text: "t", html: "h",
        zipFilename: "202606_領収書.zip",
        zipBytes: new Uint8Array(10),
        idempotencyKey: "k",
      }),
    /must be pure ASCII/,
  );
  assert.equal(calls.length, 0);
});

test("performDelivery: a Resend 4xx failure classifies DEFINITIVE (terminal)", async () => {
  const { fetchImpl } = fakeResend({ ok: false, status: 422 });
  const r = await performDelivery({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: "key", from: "f", to: "t", cc: null, subject: "s", text: "t", html: "h",
    zipFilename: "pack.zip", zipBytes: new Uint8Array(10), idempotencyKey: "k",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error, "boom");
    assert.equal(r.classification, "definitive", "4xx ⇒ definitive (mail never accepted; fresh attempt is safe)");
  }
});

test("performDelivery: a Resend 5xx failure classifies AMBIGUOUS (resumable — mail may be accepted)", async () => {
  const { fetchImpl } = fakeResend({ ok: false, status: 502 });
  const r = await performDelivery({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: "key", from: "f", to: "t", cc: null, subject: "s", text: "t", html: "h",
    zipFilename: "pack.zip", zipBytes: new Uint8Array(10), idempotencyKey: "k",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.classification, "ambiguous", "5xx ⇒ ambiguous");
});

test("performDelivery: a transport error (no response) classifies AMBIGUOUS — never infer 'not sent'", async () => {
  // fetch throws (timeout / network) ⇒ no status ⇒ ambiguous.
  const throwingFetch = async () => {
    throw new Error("Network connection lost");
  };
  const r = await performDelivery({
    fetchImpl: throwingFetch as unknown as typeof fetch,
    apiKey: "key", from: "f", to: "t", cc: null, subject: "s", text: "t", html: "h",
    zipFilename: "pack.zip", zipBytes: new Uint8Array(10), idempotencyKey: "k",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /Network connection lost/);
    assert.equal(r.classification, "ambiguous", "no response ⇒ ambiguous, never definitive");
  }
});
