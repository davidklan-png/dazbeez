// Mobile bearer-token device trust for the receipts capture app.
//
// Bearer format: base64url(JSON payload) + "." + hex(HMAC-SHA256(secret, payload))
// Payload: { id, actor, iat }   (iat = unix seconds, informational only)
//
// The token is stored only on the device; the server keeps no copy. Revocation
// is enforced by trusted_devices.revoked_at. A mobile bearer authorizes only
// when the DB row is platform ios|android, is not revoked, and its actor equals
// the signed payload actor — so a historical browser-cookie row (platform NULL)
// can never authorize as a mobile bearer (see isMobileBearerRowAcceptable).
//
// History: this module previously also minted a "remember this browser" HMAC
// cookie (receipts_device) for web auth. That path was retired when receipts
// web authentication moved to Clerk. Historical browser rows remain in
// trusted_devices but are inert, hidden from Settings, and never usable for
// authorization. Mobile pairing + bearer authentication below is the only live
// trust path. Mobile bearer tokens carry no fixed expiry; revocation is the
// only control (token expiry is a separate follow-up).

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { newUuid, nowIso } from "@/lib/receipts/db-utils";

const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

export type MobilePlatform = "ios" | "android";

export interface MobileDeviceRow {
  id: string;
  actor: string;
  label: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  platform: string | null;
  app_version: string | null;
  scopes_json: string | null;
}

interface MobileTokenPayload {
  id: string;
  actor: string;
  iat: number; // unix seconds, informational
}

export type MobileScope =
  | "receipt:create"
  | "business_card:create"
  | "device:heartbeat";

export const DEFAULT_MOBILE_SCOPES: MobileScope[] = [
  "receipt:create",
  "business_card:create",
  "device:heartbeat",
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getDeviceSecret(): string | null {
  const s = process.env.RECEIPTS_DEVICE_SECRET?.trim();
  return s && s.length >= 32 ? s : null;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std.padEnd(std.length + ((4 - (std.length % 4)) % 4), "=");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}

async function hmacHex(secret: string, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", copyToArrayBuffer(textEncoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, copyToArrayBuffer(message));
  return bytesToHex(new Uint8Array(sig));
}

// base64url(JSON payload) + "." + hex(HMAC). Shared by the bearer signer and
// verifier; the on-the-wire layout must not change (existing devices carry
// tokens in exactly this shape).
function encodeSignedValue(payload: MobileTokenPayload, sig: string): string {
  const json = JSON.stringify(payload);
  const encoded = bytesToBase64Url(textEncoder.encode(json));
  return `${encoded}.${sig}`;
}

function parseSignedValue(value: string): { raw: Uint8Array; encodedPayload: string; sig: string } | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const encodedPayload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!encodedPayload || sig.length !== 64) return null;
  try {
    const raw = base64UrlToBytes(encodedPayload);
    return { raw, encodedPayload, sig };
  } catch {
    return null;
  }
}

function readBearerToken(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]!.trim() : null;
}

function parseBearerToken(value: string): { raw: Uint8Array; encodedPayload: string; sig: string } | null {
  return parseSignedValue(value);
}

// ─── Mobile-platform predicate (single source of truth) ───────────────────────
//
// The canonical definition of "a mobile device row". Used by the bearer row
// check (isMobileBearerRowAcceptable) and the management selection guard
// (filterActiveMobileDevices). Historical browser rows have platform NULL and
// are excluded everywhere.

export function isMobilePlatform(platform: string | null): platform is MobilePlatform {
  return platform === "ios" || platform === "android";
}

// ─── Pure authorization boundary (no I/O → unit-tested) ──────────────────────
//
// verifyBearerDevice splits into three pure checks so the mobile bearer
// authorization boundary is unit-testable without live D1 bindings:
//   1. verifyMobileBearerPayload  — signed-payload shape (id/actor/iat)
//   2. verifySignedMobileBearer   — parse + HMAC + (1). The no-DB portion of
//      verifyBearerDevice; the secret is passed in, not read from env.
//   3. isMobileBearerRowAcceptable — DB-row rules (exists, not revoked,
//      platform ios|android, row actor === payload actor).

export interface VerifiedBearerPayload {
  id: string;
  actor: string;
  iat: number;
}

/** Non-empty id/actor and a finite, positive `iat`. HMAC is checked separately. */
export function verifyMobileBearerPayload(payload: unknown): VerifiedBearerPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { id, actor, iat } = payload as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof actor !== "string" || actor.length === 0) return null;
  // `iat` must be a finite, positive number. A historical browser-cookie
  // payload carries `exp` (not `iat`), so its decoded `iat` is undefined and
  // is rejected here even before the platform/actor row check.
  if (typeof iat !== "number" || !Number.isFinite(iat) || iat <= 0) return null;
  return { id, actor, iat };
}

export interface MobileBearerRow {
  actor: string;
  platform: string | null;
  revoked_at: string | null;
}

/**
 * Row-level rules for a mobile bearer whose HMAC + payload shape already
 * verified. The row must exist, not be revoked, be platform ios|android, and
 * its stored actor must equal the signed payload actor. A historical browser
 * row (platform NULL) or a row whose actor was swapped fails here.
 */
export function isMobileBearerRowAcceptable(
  payload: VerifiedBearerPayload,
  row: MobileBearerRow | null,
): boolean {
  if (!row) return false;
  if (row.revoked_at) return false;
  if (!isMobilePlatform(row.platform)) return false;
  if (row.actor !== payload.actor) return false;
  return true;
}

/** Parse + HMAC-verify + payload-shape check. No DB access, no env read. */
export async function verifySignedMobileBearer(
  secret: string,
  token: string,
): Promise<VerifiedBearerPayload | null> {
  const parsed = parseBearerToken(token);
  if (!parsed) return null;
  const expected = await hmacHex(secret, parsed.raw);
  if (!constantTimeEqual(expected, parsed.sig)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(textDecoder.decode(parsed.raw));
  } catch {
    return null;
  }
  return verifyMobileBearerPayload(decoded);
}

/**
 * In-memory guard that keeps only active (non-revoked) mobile rows. The list
 * queries already constrain `platform IN ('ios','android') AND revoked_at IS
 * NULL` at the DB; this is defense-in-depth and the tested guarantee that a
 * historical platform-NULL browser row can never surface in Settings.
 */
export function filterActiveMobileDevices(rows: MobileDeviceRow[]): MobileDeviceRow[] {
  return rows.filter((r) => r.revoked_at === null && isMobilePlatform(r.platform));
}

// ─── Mobile enrollment (pairing) ──────────────────────────────────────────────

export async function enrollMobileDevice(input: {
  actor: string;
  label: string;
  userAgent: string | null;
  platform: MobilePlatform;
  appVersion: string | null;
  scopes: MobileScope[];
}): Promise<{ id: string; bearerToken: string }> {
  const secret = getDeviceSecret();
  if (!secret) {
    throw new Error("RECEIPTS_DEVICE_SECRET is not configured (must be ≥32 chars).");
  }

  const id = newUuid();
  const iat = Math.floor(Date.now() / 1000);
  const payload: MobileTokenPayload = { id, actor: input.actor, iat };
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  const sig = await hmacHex(secret, payloadBytes);
  const bearerToken = encodeSignedValue(payload, sig);

  const db = getReceiptsDb();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO trusted_devices
        (id, actor, label, user_agent, created_at, last_seen_at,
         platform, app_version, scopes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.actor,
      input.label,
      input.userAgent,
      now,
      now,
      input.platform,
      input.appVersion,
      JSON.stringify(input.scopes),
    )
    .run();

  return { id, bearerToken };
}

interface MobileActor {
  deviceId: string;
  actor: string;
  scopes: MobileScope[];
  platform: string | null;
  appVersion: string | null;
}

export async function verifyBearerDevice(headers: Headers): Promise<MobileActor | null> {
  const secret = getDeviceSecret();
  if (!secret) return null;
  const token = readBearerToken(headers);
  if (!token) return null;

  const payload = await verifySignedMobileBearer(secret, token);
  if (!payload) return null;

  const db = getReceiptsDb();
  const row = await db
    .prepare(
      `SELECT actor, revoked_at, last_seen_at, scopes_json, platform, app_version
       FROM trusted_devices WHERE id = ? LIMIT 1`,
    )
    .bind(payload.id)
    .first<{
      actor: string;
      revoked_at: string | null;
      last_seen_at: string | null;
      scopes_json: string | null;
      platform: string | null;
      app_version: string | null;
    }>();
  if (!isMobileBearerRowAcceptable(payload, row)) return null;

  let scopes: MobileScope[] = DEFAULT_MOBILE_SCOPES;
  if (row!.scopes_json) {
    try {
      const parsedScopes = JSON.parse(row!.scopes_json);
      if (Array.isArray(parsedScopes)) {
        scopes = parsedScopes.filter(
          (s): s is MobileScope =>
            s === "receipt:create" ||
            s === "business_card:create" ||
            s === "device:heartbeat",
        );
      }
    } catch {
      // fall through to default scopes
    }
  }

  // last_seen_at throttle.
  const now = Date.now();
  const last = row!.last_seen_at ? Date.parse(row!.last_seen_at) : 0;
  if (!Number.isFinite(last) || now - last > LAST_SEEN_THROTTLE_MS) {
    db.prepare(`UPDATE trusted_devices SET last_seen_at = ? WHERE id = ?`)
      .bind(new Date(now).toISOString(), payload.id)
      .run()
      .catch(() => {});
  }

  return {
    deviceId: payload.id,
    actor: payload.actor,
    scopes,
    platform: row!.platform,
    appVersion: row!.app_version,
  };
}

export async function requireMobileActor(
  headers: Headers,
  requiredScope: MobileScope,
): Promise<MobileActor> {
  const actor = await verifyBearerDevice(headers);
  if (!actor) {
    throw new Error("Unauthorized mobile request.");
  }
  if (!actor.scopes.includes(requiredScope)) {
    throw new Error(`Forbidden: missing scope ${requiredScope}`);
  }
  return actor;
}

export async function updateMobileDeviceAppVersion(
  deviceId: string,
  appVersion: string,
): Promise<void> {
  const db = getReceiptsDb();
  await db
    .prepare(
      `UPDATE trusted_devices SET app_version = ?
       WHERE id = ? AND platform IN ('ios', 'android')`,
    )
    .bind(appVersion, deviceId)
    .run();
}

// ─── Mobile device management (Settings) ──────────────────────────────────────
//
// All list/revoke queries constrain platform to ios|android, so a guessed
// historical browser row id can neither appear in Settings nor be revoked
// through the management endpoint. filterActiveMobileDevices is a final
// in-memory guard on top of the SQL constraint.

export async function listMobileDevicesForActor(actor: string): Promise<MobileDeviceRow[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT id, actor, label, user_agent, created_at, last_seen_at, revoked_at,
              platform, app_version, scopes_json
       FROM trusted_devices
       WHERE actor = ? AND revoked_at IS NULL AND platform IN ('ios', 'android')
       ORDER BY created_at DESC`,
    )
    .bind(actor)
    .all<MobileDeviceRow>();
  return filterActiveMobileDevices(result.results ?? []);
}

export async function listAllMobileDevices(): Promise<MobileDeviceRow[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT id, actor, label, user_agent, created_at, last_seen_at, revoked_at,
              platform, app_version, scopes_json
       FROM trusted_devices
       WHERE revoked_at IS NULL AND platform IN ('ios', 'android')
       ORDER BY created_at DESC`,
    )
    .all<MobileDeviceRow>();
  return filterActiveMobileDevices(result.results ?? []);
}

export async function revokeMobileDevice(id: string, actor: string): Promise<void> {
  const db = getReceiptsDb();
  await db
    .prepare(
      `UPDATE trusted_devices SET revoked_at = ?
       WHERE id = ? AND actor = ? AND revoked_at IS NULL
         AND platform IN ('ios', 'android')`,
    )
    .bind(nowIso(), id, actor)
    .run();
}

/** Revoke any mobile device by id regardless of owner. Gated to owners in the route. */
export async function revokeMobileDeviceById(id: string): Promise<void> {
  const db = getReceiptsDb();
  await db
    .prepare(
      `UPDATE trusted_devices SET revoked_at = ?
       WHERE id = ? AND revoked_at IS NULL AND platform IN ('ios', 'android')`,
    )
    .bind(nowIso(), id)
    .run();
}
