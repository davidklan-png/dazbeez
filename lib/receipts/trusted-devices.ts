// Cookie format: base64url(JSON payload) + "." + hex(HMAC-SHA256(secret, payload))
// Payload: { id, actor, exp }
//
// Middleware verifies HMAC only — zero DB calls, zero network calls.
// Route handlers additionally check DB for revocation.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { newUuid, nowIso } from "@/lib/receipts/db-utils";

export const DEVICE_COOKIE_NAME = "receipts_device";
const DEVICE_COOKIE_SECS = 365 * 24 * 60 * 60; // 1 year
const LAST_SEEN_THROTTLE_MS = 60 * 60 * 1000;

export interface TrustedDeviceRow {
  id: string;
  actor: string;
  label: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface DevicePayload {
  id: string;
  actor: string;
  exp: number; // unix seconds
}

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

function encodeCookieValue(payload: DevicePayload, sig: string): string {
  const json = JSON.stringify(payload);
  const encoded = bytesToBase64Url(textEncoder.encode(json));
  return `${encoded}.${sig}`;
}

function parseCookieValue(value: string): { raw: Uint8Array; encodedPayload: string; sig: string } | null {
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

export function readRawDeviceCookie(headers: Headers): string | null {
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === DEVICE_COOKIE_NAME) return rest.join("=") || null;
  }
  return null;
}

// ─── Middleware-safe: HMAC only, no DB, no network ───────────────────────────

export async function verifyDeviceCookieLight(
  headers: Headers,
): Promise<{ id: string; actor: string } | null> {
  const secret = getDeviceSecret();
  if (!secret) return null;
  const raw = readRawDeviceCookie(headers);
  if (!raw) return null;
  const parsed = parseCookieValue(raw);
  if (!parsed) return null;

  const expected = await hmacHex(secret, parsed.raw);
  if (!constantTimeEqual(expected, parsed.sig)) return null;

  let payload: DevicePayload;
  try {
    payload = JSON.parse(textDecoder.decode(parsed.raw)) as DevicePayload;
  } catch {
    return null;
  }

  if (!payload.id || !payload.actor || !payload.exp) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return { id: payload.id, actor: payload.actor };
}

// ─── Full: HMAC + DB revocation check (for route handlers/layouts) ───────────

export async function verifyDeviceCookie(
  headers: Headers,
): Promise<{ deviceId: string; actor: string } | null> {
  const light = await verifyDeviceCookieLight(headers);
  if (!light) return null;

  const db = getReceiptsDb();
  const row = await db
    .prepare(`SELECT revoked_at, last_seen_at FROM trusted_devices WHERE id = ? LIMIT 1`)
    .bind(light.id)
    .first<{ revoked_at: string | null; last_seen_at: string | null }>();

  if (!row || row.revoked_at) return null;

  const now = Date.now();
  const last = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
  if (!Number.isFinite(last) || now - last > LAST_SEEN_THROTTLE_MS) {
    db.prepare(`UPDATE trusted_devices SET last_seen_at = ? WHERE id = ?`)
      .bind(new Date(now).toISOString(), light.id)
      .run()
      .catch(() => {});
  }

  return { deviceId: light.id, actor: light.actor };
}

// ─── Enrollment ───────────────────────────────────────────────────────────────

export async function enrollDevice(input: {
  actor: string;
  label: string;
  userAgent: string | null;
}): Promise<{ id: string; cookie: string }> {
  const secret = getDeviceSecret();
  if (!secret) {
    throw new Error("RECEIPTS_DEVICE_SECRET is not configured (must be ≥32 chars).");
  }

  const id = newUuid();
  const exp = Math.floor(Date.now() / 1000) + DEVICE_COOKIE_SECS;
  const payload: DevicePayload = { id, actor: input.actor, exp };
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  const sig = await hmacHex(secret, payloadBytes);
  const cookieValue = encodeCookieValue(payload, sig);

  const db = getReceiptsDb();
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO trusted_devices
        (id, actor, label, user_agent, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.actor, input.label, input.userAgent, now, now)
    .run();

  const cookie = [
    `${DEVICE_COOKIE_NAME}=${cookieValue}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${DEVICE_COOKIE_SECS}`,
  ].join("; ");

  return { id, cookie };
}

// ─── Management ───────────────────────────────────────────────────────────────

export function buildClearDeviceCookie(): string {
  return [
    `${DEVICE_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export async function listDevicesForActor(actor: string): Promise<TrustedDeviceRow[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT id, actor, label, user_agent, created_at, last_seen_at, revoked_at
       FROM trusted_devices WHERE actor = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .bind(actor)
    .all<TrustedDeviceRow>();
  return result.results ?? [];
}

export async function revokeDevice(id: string, actor: string): Promise<void> {
  const db = getReceiptsDb();
  await db
    .prepare(
      `UPDATE trusted_devices SET revoked_at = ? WHERE id = ? AND actor = ? AND revoked_at IS NULL`,
    )
    .bind(nowIso(), id, actor)
    .run();
}

// Returns the device id currently identified by the cookie (if any), for
// highlighting "This device" in the device list.
export async function getCurrentDeviceId(headers: Headers): Promise<string | null> {
  const light = await verifyDeviceCookieLight(headers).catch(() => null);
  return light?.id ?? null;
}
