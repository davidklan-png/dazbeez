import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  DEFAULT_MOBILE_SCOPES,
  filterActiveMobileDevices,
  isMobileBearerRowAcceptable,
  isMobilePlatform,
  verifyMobileBearerPayload,
  verifySignedMobileBearer,
  type VerifiedBearerPayload,
} from "@/lib/receipts/trusted-devices";

// Reference signer that independently reproduces the on-the-wire format:
// base64url(JSON {id, actor, iat}) + "." + hex(HMAC-SHA256(secret, json bytes)).
// Built only here (test code) — the production signer in trusted-devices.ts is
// never imported for signing, so this is an independent cross-check of the
// verifier.
const SECRET = "x".repeat(40); // ≥32 chars, like the real secret check requires

function signHex(secret: string, json: string): string {
  return createHmac("sha256", secret).update(json, "utf8").digest("hex");
}

function makeToken(secret: string, payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  return `${b64}.${signHex(secret, json)}`;
}

const validPayload = { id: "dev_123", actor: "user@example.com", iat: 1_700_000_000 };

// ─── isMobilePlatform ────────────────────────────────────────────────────────

test("isMobilePlatform: ios and android are mobile", () => {
  assert.equal(isMobilePlatform("ios"), true);
  assert.equal(isMobilePlatform("android"), true);
});

test("isMobilePlatform: null, browser, and arbitrary platforms are not mobile", () => {
  assert.equal(isMobilePlatform(null), false, "null rejected");
  assert.equal(isMobilePlatform("web"), false);
  assert.equal(isMobilePlatform("browser"), false);
  assert.equal(isMobilePlatform("linux"), false);
  assert.equal(isMobilePlatform(""), false);
});

// ─── verifyMobileBearerPayload ───────────────────────────────────────────────

test("verifyMobileBearerPayload: accepts a valid mobile token payload", () => {
  assert.deepEqual(verifyMobileBearerPayload(validPayload), validPayload);
});

test("verifyMobileBearerPayload: rejects empty / missing id and actor", () => {
  assert.equal(verifyMobileBearerPayload({ ...validPayload, id: "" }), null);
  assert.equal(verifyMobileBearerPayload({ ...validPayload, actor: "" }), null);
  assert.equal(
    verifyMobileBearerPayload({ actor: validPayload.actor, iat: 1 }),
    null,
    "missing id rejected",
  );
  assert.equal(
    verifyMobileBearerPayload({ id: validPayload.id, iat: 1 }),
    null,
    "missing actor rejected",
  );
});

test("verifyMobileBearerPayload: rejects missing, zero, negative, non-numeric, or non-finite iat", () => {
  const base = { id: "dev", actor: "u@x" };
  assert.equal(verifyMobileBearerPayload({ ...base }), null, "missing iat rejected");
  assert.equal(verifyMobileBearerPayload({ ...base, iat: 0 }), null, "zero iat rejected");
  assert.equal(
    verifyMobileBearerPayload({ ...base, iat: -1 }),
    null,
    "negative iat rejected",
  );
  assert.equal(
    verifyMobileBearerPayload({ ...base, iat: "1700000000" }),
    null,
    "string iat rejected",
  );
  assert.equal(verifyMobileBearerPayload({ ...base, iat: NaN }), null, "NaN iat rejected");
  assert.equal(
    verifyMobileBearerPayload({ ...base, iat: Infinity }),
    null,
    "Infinity iat rejected",
  );
  assert.equal(
    verifyMobileBearerPayload({ ...base, iat: -Infinity }),
    null,
    "-Infinity iat rejected",
  );
});

test("verifyMobileBearerPayload: rejects a historical browser payload ({id, actor, exp}) — no iat", () => {
  // A retired browser-cookie payload carried `exp`, not `iat`. Even though id
  // and actor are present, the missing/undefined iat must reject it.
  assert.equal(
    verifyMobileBearerPayload({ id: "dev", actor: "u@x", exp: 9_999_999_999 }),
    null,
  );
});

test("verifyMobileBearerPayload: rejects non-object input", () => {
  assert.equal(verifyMobileBearerPayload(null), null);
  assert.equal(verifyMobileBearerPayload("string"), null);
  assert.equal(verifyMobileBearerPayload(42), null);
  assert.equal(verifyMobileBearerPayload(undefined), null);
});

// ─── isMobileBearerRowAcceptable ─────────────────────────────────────────────

const goodPayload: VerifiedBearerPayload = {
  id: "dev_123",
  actor: "user@example.com",
  iat: 1_700_000_000,
};

test("isMobileBearerRowAcceptable: accepts ios and android rows with matching actor", () => {
  assert.equal(
    isMobileBearerRowAcceptable(goodPayload, {
      actor: goodPayload.actor,
      platform: "ios",
      revoked_at: null,
    }),
    true,
  );
  assert.equal(
    isMobileBearerRowAcceptable(goodPayload, {
      actor: goodPayload.actor,
      platform: "android",
      revoked_at: null,
    }),
    true,
  );
});

test("isMobileBearerRowAcceptable: rejects a missing (null) row", () => {
  assert.equal(isMobileBearerRowAcceptable(goodPayload, null), false);
});

test("isMobileBearerRowAcceptable: rejects a revoked row", () => {
  assert.equal(
    isMobileBearerRowAcceptable(goodPayload, {
      actor: goodPayload.actor,
      platform: "ios",
      revoked_at: "2026-07-01T00:00:00Z",
    }),
    false,
  );
});

test("isMobileBearerRowAcceptable: rejects null / browser / arbitrary platforms", () => {
  for (const platform of [null, "web", "browser", "linux", ""]) {
    assert.equal(
      isMobileBearerRowAcceptable(goodPayload, {
        actor: goodPayload.actor,
        platform,
        revoked_at: null,
      }),
      false,
      `platform ${JSON.stringify(platform)} rejected`,
    );
  }
});

test("isMobileBearerRowAcceptable: rejects a row actor that does not match the signed payload actor", () => {
  assert.equal(
    isMobileBearerRowAcceptable(goodPayload, {
      actor: "someone-else@example.com",
      platform: "ios",
      revoked_at: null,
    }),
    false,
    "actor mismatch rejected",
  );
});

// ─── verifySignedMobileBearer (parse + HMAC + payload shape, no DB) ───────────

test("verifySignedMobileBearer: accepts a validly signed mobile token", async () => {
  const token = makeToken(SECRET, validPayload);
  assert.deepEqual(await verifySignedMobileBearer(SECRET, token), validPayload);
});

test("verifySignedMobileBearer: rejects a token signed with a different secret", async () => {
  const token = makeToken("0".repeat(40), validPayload);
  assert.equal(await verifySignedMobileBearer(SECRET, token), null);
});

test("verifySignedMobileBearer: rejects a tampered signature", async () => {
  const token = makeToken(SECRET, validPayload);
  // Flip the last hex character of the signature.
  const last = token.slice(-1);
  const flipped = last === "0" ? "1" : "0";
  const tampered = token.slice(0, -1) + flipped;
  assert.equal(await verifySignedMobileBearer(SECRET, tampered), null);
});

test("verifySignedMobileBearer: rejects malformed signed values", async () => {
  assert.equal(await verifySignedMobileBearer(SECRET, ""), null, "empty rejected");
  assert.equal(await verifySignedMobileBearer(SECRET, "no-dot-here"), null, "no dot rejected");
  // Signature must be exactly 64 hex chars.
  assert.equal(
    await verifySignedMobileBearer(SECRET, "eyAiZCI6IDEgfQ.00"),
    null,
    "short signature rejected",
  );
});

test("verifySignedMobileBearer: rejects a structurally valid token whose payload is a browser payload (no iat)", async () => {
  // Signed with the right secret and well-formed, but the payload is the
  // retired browser shape — the iat check must still reject it.
  const token = makeToken(SECRET, { id: "dev", actor: "u@x", exp: 9_999_999_999 });
  assert.equal(await verifySignedMobileBearer(SECRET, token), null);
});

// ─── filterActiveMobileDevices (management selection) ────────────────────────

test("filterActiveMobileDevices: keeps only active ios/android rows and excludes browser (platform-NULL) rows", () => {
  const rows = [
    { id: "a", actor: "u", label: "iPhone", user_agent: null, created_at: "", last_seen_at: null, revoked_at: null, platform: "ios", app_version: null, scopes_json: null },
    { id: "b", actor: "u", label: "Android", user_agent: null, created_at: "", last_seen_at: null, revoked_at: null, platform: "android", app_version: null, scopes_json: null },
    // Historical browser rows — must never surface.
    { id: "c", actor: "u", label: "MacBook", user_agent: "Mozilla", created_at: "", last_seen_at: null, revoked_at: null, platform: null, app_version: null, scopes_json: null },
    { id: "d", actor: "u", label: "PC", user_agent: "Mozilla", created_at: "", last_seen_at: null, revoked_at: null, platform: "web", app_version: null, scopes_json: null },
    // Revoked mobile — excluded.
    { id: "e", actor: "u", label: "OldiPhone", user_agent: null, created_at: "", last_seen_at: null, revoked_at: "2026-01-01T00:00:00Z", platform: "ios", app_version: null, scopes_json: null },
  ];
  const kept = filterActiveMobileDevices(rows).map((r) => r.id);
  assert.deepEqual(kept, ["a", "b"]);
});

// ─── default scopes preserved ────────────────────────────────────────────────

test("DEFAULT_MOBILE_SCOPES: unchanged wire-compatible default scopes", () => {
  assert.deepEqual(DEFAULT_MOBILE_SCOPES, [
    "receipt:create",
    "business_card:create",
    "device:heartbeat",
  ]);
});
