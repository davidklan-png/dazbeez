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

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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

// ─── CF Access JWT verification ───────────────────────────────────────────────
// Receipt routes contain tax records and receipt images, so a decoded JWT
// payload is never enough. Direct Worker/preview hostnames can receive
// client-supplied headers; validate the Access token signature, issuer, expiry,
// and audience before accepting it.

interface CfAccessPayload {
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
}

interface CfAccessJwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface CfAccessJwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

interface CfAccessJwksResponse {
  keys?: CfAccessJwk[];
}

let jwksCache:
  | {
      issuer: string;
      fetchedAt: number;
      keys: CfAccessJwk[];
    }
  | null = null;

const JWKS_CACHE_MS = 60 * 60 * 1000;

function decodeJwtPart<T>(part: string): T | null {
  try {
    const json = textDecoder.decode(base64UrlDecode(part));
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function splitJwt(token: string): [string, string, string] | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) return null;
  return [header, payload, signature];
}

function getCfAccessIssuer(): string | null {
  const team = process.env.CF_ACCESS_TEAM?.trim();
  if (!team) return null;
  const host = team
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!host) return null;
  return `https://${host}`;
}

async function getCfAccessJwks(issuer: string): Promise<CfAccessJwk[]> {
  const now = Date.now();
  if (
    jwksCache &&
    jwksCache.issuer === issuer &&
    now - jwksCache.fetchedAt < JWKS_CACHE_MS
  ) {
    return jwksCache.keys;
  }

  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return [];

  const payload = (await response.json().catch(() => ({}))) as CfAccessJwksResponse;
  const keys = (payload.keys ?? []).filter(
    (key) => key.kty === "RSA" && !!key.kid && !!key.n && !!key.e,
  );
  jwksCache = { issuer, fetchedAt: now, keys };
  return keys;
}

async function verifyJwtSignature(
  tokenParts: [string, string, string],
  jwk: CfAccessJwk,
): Promise<boolean> {
  const [encodedHeader, encodedPayload, encodedSignature] = tokenParts;
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      ext: true,
    },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = base64UrlDecode(encodedSignature);
  const signedBytes = textEncoder.encode(`${encodedHeader}.${encodedPayload}`);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    copyToArrayBuffer(signature),
    copyToArrayBuffer(signedBytes),
  );
}

async function isCfAccessTokenAcceptable(
  token: string | null,
): Promise<{ ok: boolean; email: string | null }> {
  if (!token) return { ok: false, email: null };
  const issuer = getCfAccessIssuer();
  const expectedAudience = process.env.CF_ACCESS_AUD?.trim();
  if (!issuer || !expectedAudience) return { ok: false, email: null };

  const tokenParts = splitJwt(token);
  if (!tokenParts) return { ok: false, email: null };

  const header = decodeJwtPart<CfAccessJwtHeader>(tokenParts[0]);
  const payload = decodeJwtPart<CfAccessPayload>(tokenParts[1]);
  if (!header || header.alg !== "RS256" || !header.kid) return { ok: false, email: null };
  if (!payload) return { ok: false, email: null };

  if (payload.iss !== issuer) return { ok: false, email: null };

  const nowSeconds = Date.now() / 1000;
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds) {
    return { ok: false, email: null };
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds) {
    return { ok: false, email: null };
  }

  const aud = payload.aud;
  const audMatch = Array.isArray(aud)
    ? aud.includes(expectedAudience)
    : aud === expectedAudience;
  if (!audMatch) return { ok: false, email: null };

  const keys = await getCfAccessJwks(issuer);
  const key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key) return { ok: false, email: null };

  try {
    const valid = await verifyJwtSignature(tokenParts, key);
    if (!valid) return { ok: false, email: null };
  } catch {
    return { ok: false, email: null };
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

export async function isReceiptsAuthorized(
  requestHeaders: Headers,
): Promise<boolean> {
  // 1. Trusted-device cookie (HMAC + DB revocation check).
  const device = await verifyDeviceCookie(requestHeaders).catch(() => null);
  if (device) return true;

  // 2. CF Access JWT — signature + issuer + audience verified.
  const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
  const { ok } = await isCfAccessTokenAcceptable(token);
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

  const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
  const { ok } = await isCfAccessTokenAcceptable(token);
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

// Single-pass: verifies auth and returns the actor. Replaces the previous
// assertReceiptsAccessFromHeaders + getReceiptsActor pair that every receipts
// route called, which performed verifyDeviceCookie (HMAC + D1 lookup for
// revocation) twice per request.
export async function requireReceiptsActor(
  requestHeaders: Headers,
): Promise<string> {
  // 1. Trusted-device cookie (HMAC + DB revocation check).
  const device = await verifyDeviceCookie(requestHeaders).catch(() => null);
  if (device) return device.actor;

  // 2. CF Access JWT.
  const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
  const { ok, email } = await isCfAccessTokenAcceptable(token);
  if (ok) return email ?? "receipts";

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
      return provided.username;
    }
  }

  throw new Error("Unauthorized receipts request.");
}
