import {
  verifyDeviceCookie,
  verifyDeviceCookieLight,
} from "@/lib/receipts/trusted-devices";

const RECEIPTS_REALM = "Dazbeez Receipts";
const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type BasicCredentials = { username: string; password: string };

// ─── JWKS cache (module-scope, lives for Worker instance lifetime) ──────────

type JwksCache = { keys: JsonWebKey[]; fetchedAt: number };
const jwksCache = new Map<string, JwksCache>();

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

function base64UrlDecode(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64UrlToBase64(b64url);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeJwtPart(part: string): Record<string, unknown> {
  try {
    return JSON.parse(textDecoder.decode(base64UrlDecode(part))) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
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

// ─── JWKS fetch ──────────────────────────────────────────────────────────────

async function fetchJwks(teamDomain: string): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS from ${url}: ${res.status}`);
  }

  const json = (await res.json()) as { keys?: JsonWebKey[] };
  const keys = json.keys ?? [];
  jwksCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

// ─── CF Access JWT verification ───────────────────────────────────────────

async function verifyCloudflareAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<{ valid: boolean; email: string | null }> {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, email: null };

  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];
  const header = decodeJwtPart(headerPart);
  const payload = decodeJwtPart(payloadPart);

  // Verify expiry
  if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) {
    return { valid: false, email: null };
  }

  // Verify audience
  const aud = payload.aud;
  const audMatch = Array.isArray(aud)
    ? aud.includes(audience)
    : aud === audience;
  if (!audMatch) return { valid: false, email: null };

  // Find matching key
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const alg = typeof header.alg === "string" ? header.alg : "RS256";

  let keys: JsonWebKey[];
  try {
    keys = await fetchJwks(teamDomain);
  } catch {
    return { valid: false, email: null };
  }

  const jwk = kid
    ? keys.find((k) => (k as Record<string, unknown>).kid === kid)
    : keys[0];

  if (!jwk) return { valid: false, email: null };

  // Import key
  let algorithm: RsaHashedImportParams | EcKeyImportParams;
  if (alg === "RS256") {
    algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  } else if (alg === "ES256") {
    algorithm = { name: "ECDSA", namedCurve: "P-256" };
  } else {
    return { valid: false, email: null };
  }

  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey("jwk", jwk, algorithm, false, [
      "verify",
    ]);
  } catch {
    return { valid: false, email: null };
  }

  // Verify signature
  const signingInput = textEncoder.encode(`${headerPart}.${payloadPart}`);
  const signature = base64UrlDecode(sigPart);

  let verifyAlgorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
  if (alg === "ES256") {
    verifyAlgorithm = { name: "ECDSA", hash: "SHA-256" };
  } else {
    verifyAlgorithm = { name: "RSASSA-PKCS1-v1_5" };
  }

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(verifyAlgorithm, cryptoKey, signature, signingInput);
  } catch {
    valid = false;
  }

  const email =
    valid && typeof payload.email === "string" ? payload.email : null;

  return { valid, email };
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

  const teamDomain = process.env.CF_ACCESS_TEAM?.trim();
  const audience = process.env.CF_ACCESS_AUD?.trim();

  if (teamDomain && audience) {
    const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
    if (token) {
      const { email } = await verifyCloudflareAccessJwt(token, teamDomain, audience);
      if (email) return email;
    }
  }

  const creds = decodeBasicAuthorization(requestHeaders.get("authorization"));
  if (creds) return creds.username;

  return "receipts";
}

export async function isReceiptsAuthorized(
  requestHeaders: Headers,
): Promise<boolean> {
  // 1. Trusted-device cookie — primary path once enrolled.
  const device = await verifyDeviceCookie(requestHeaders).catch(() => null);
  if (device) return true;

  // 2. Cloudflare Access JWT — used at the enrollment edge (production).
  const teamDomain = process.env.CF_ACCESS_TEAM?.trim();
  const audience = process.env.CF_ACCESS_AUD?.trim();
  if (teamDomain && audience) {
    const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
    if (token) {
      const { valid } = await verifyCloudflareAccessJwt(token, teamDomain, audience);
      if (valid) return true;
    }
  }

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

// Middleware-safe: no DB calls, no JWKS fetch, no RSA.
// Uses HMAC-verified self-contained cookie, or just checks CF Access header
// presence (edge already validated the identity before it reached the Worker).
export async function isReceiptsAuthorizedLight(
  requestHeaders: Headers,
): Promise<boolean> {
  // 1. Trusted-device cookie — HMAC verify, no DB.
  const device = await verifyDeviceCookieLight(requestHeaders).catch(() => null);
  if (device) return true;

  // 2. CF Access header presence — edge enforcement already did RSA verification.
  //    Full JWT verify happens in route handlers via isReceiptsAuthorized.
  const teamDomain = process.env.CF_ACCESS_TEAM?.trim();
  const audience = process.env.CF_ACCESS_AUD?.trim();
  if (teamDomain && audience) {
    const token = requestHeaders.get("Cf-Access-Jwt-Assertion");
    if (token) return true;
  }

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

export async function assertReceiptsAccessFromHeaders(
  requestHeaders: Headers,
): Promise<void> {
  const authorized = await isReceiptsAuthorized(requestHeaders);
  if (!authorized) {
    throw new Error("Unauthorized receipts request.");
  }
}
