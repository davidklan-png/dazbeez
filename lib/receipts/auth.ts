import {
  verifyDeviceCookie,
  verifyDeviceCookieLight,
} from "@/lib/receipts/trusted-devices";

const RECEIPTS_REALM = "Dazbeez Receipts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type BasicCredentials = { username: string; password: string };

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeEqual(left: string, right: string) {
  const l = textEncoder.encode(left);
  const r = textEncoder.encode(right);
  const length = Math.max(l.length, r.length);
  let mismatch = l.length ^ r.length;
  for (let i = 0; i < length; i += 1) {
    mismatch |= (l[i] ?? 0) ^ (r[i] ?? 0);
  }
  return mismatch === 0;
}

function decodeBase64(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return textDecoder.decode(bytes);
}

function base64UrlToBase64(b64url: string): string {
  return b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    b64url.length + ((4 - (b64url.length % 4)) % 4),
    "=",
  );
}

function base64UrlDecode(b64url: string): Uint8Array {
  const b64 = base64UrlToBase64(b64url);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBasicAuthorization(value: string | null): BasicCredentials | null {
  if (!value?.startsWith("Basic ")) return null;
  const encoded = value.slice(6).trim();
  if (!encoded) return null;
  try {
    const decoded = decodeBase64(encoded);
    const sep = decoded.indexOf(":");
    if (sep <= 0) return null;
    return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

// ─── CF Access JWT decoding (no signature verification) ───────────────────────
// CF Access strips client-supplied Cf-Access-Jwt-Assertion headers at the edge
// and only sets them on requests it has authenticated. The Worker therefore
// trusts the header presence and decodes the payload without re-running RSA
// (which would blow the Worker CPU budget — see error 1102).

interface CfAccessPayload {
  email?: string;
  aud?: string | string[];
  exp?: number;
}

function decodeCfAccessPayload(token: string): CfAccessPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = textDecoder.decode(base64UrlDecode(parts[1]!));
    return JSON.parse(json) as CfAccessPayload;
  } catch {
    return null;
  }
}

function isCfAccessTokenAcceptable(
  token: string | null,
  expectedAudience: string | undefined,
): { ok: boolean; email: string | null } {
  if (!token) return { ok: false, email: null };
  const payload = decodeCfAccessPayload(token);
  if (!payload) return { ok: false, email: null };

  if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
    return { ok: false, email: null };
  }

  if (expectedAudience) {
    const aud = payload.aud;
    const audMatch = Array.isArray(aud)
      ? aud.includes(expectedAudience)
      : aud === expectedAudience;
    if (!audMatch) return { ok: false, email: null };
  }

  return { ok: true, email: payload.email ?? null };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getReceiptsAuthChallengeHeaders(): Record<string, string> {
  // Only advertise Basic auth when Basic is actually configured (local dev).
  // In production CF Access handles the challenge at the edge — sending a
  // Basic header here triggers a useless browser popup.
  const hasBasic =
    !!process.env.RECEIPTS_AUTH_USERNAME?.trim() &&
    !!process.env.RECEIPTS_AUTH_PASSWORD;
  if (!hasBasic) return {};
  return {
    "WWW-Authenticate": `Basic realm="${RECEIPTS_REALM}", charset="UTF-8"`,
  };
}

export async function getReceiptsActor(
  requestHeaders: Headers,
): Promise<string> {
  const device = await verifyDeviceCookie(requestHeaders).catch(() => null);
  if (device) return device.actor;

  const audience = process.env.CF_ACCESS_AUD?.trim();
  const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
  const { ok, email } = isCfAccessTokenAcceptable(token, audience);
  if (ok && email) return email;

  const creds = decodeBasicAuthorization(requestHeaders.get("authorization"));
  if (creds) return creds.username;

  return "receipts";
}

export async function isReceiptsAuthorized(
  requestHeaders: Headers,
): Promise<boolean> {
  // 1. Trusted-device cookie (HMAC + DB revocation check).
  const device = await verifyDeviceCookie(requestHeaders).catch(() => null);
  if (device) return true;

  // 2. CF Access JWT — decode + audience match (no RSA, edge already verified).
  const audience = process.env.CF_ACCESS_AUD?.trim();
  const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
  const { ok } = isCfAccessTokenAcceptable(token, audience);
  if (ok) return true;

  // 3. Basic auth — local dev only.
  const configuredUsername = process.env.RECEIPTS_AUTH_USERNAME?.trim();
  const configuredPassword = process.env.RECEIPTS_AUTH_PASSWORD;
  if (configuredUsername && configuredPassword) {
    const provided = decodeBasicAuthorization(requestHeaders.get("authorization"));
    if (
      provided &&
      safeEqual(provided.username, configuredUsername) &&
      safeEqual(provided.password, configuredPassword)
    ) {
      return true;
    }
  }

  return false;
}

// Middleware-safe: no DB calls. Cookie via HMAC only; CF Access via decode.
export async function isReceiptsAuthorizedLight(
  requestHeaders: Headers,
): Promise<boolean> {
  const device = await verifyDeviceCookieLight(requestHeaders).catch(() => null);
  if (device) return true;

  const audience = process.env.CF_ACCESS_AUD?.trim();
  const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
  const { ok } = isCfAccessTokenAcceptable(token, audience);
  if (ok) return true;

  const configuredUsername = process.env.RECEIPTS_AUTH_USERNAME?.trim();
  const configuredPassword = process.env.RECEIPTS_AUTH_PASSWORD;
  if (configuredUsername && configuredPassword) {
    const provided = decodeBasicAuthorization(requestHeaders.get("authorization"));
    if (
      provided &&
      safeEqual(provided.username, configuredUsername) &&
      safeEqual(provided.password, configuredPassword)
    ) {
      return true;
    }
  }

  return false;
}

export async function assertReceiptsAccessFromHeaders(
  requestHeaders: Headers,
): Promise<void> {
  const authorized = await isReceiptsAuthorized(requestHeaders);
  if (!authorized) {
    throw new Error("Unauthorized receipts request.");
  }
}
