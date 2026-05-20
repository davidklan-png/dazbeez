// Mobile device pairing flow.
//
// 1. iPhone calls POST /api/mobile/auth/start-pairing → backend mints code DAZ-7K3M.
// 2. Operator visits /receipts/pair?code=DAZ-7K3M behind Cloudflare Access
//    and clicks "Pair this iPhone" → POST /api/mobile/auth/complete-pairing
//    consumes the code, enrolls the device, and stores the bearer token in the
//    pairing-codes row so the polling iPhone can pick it up.
// 3. iPhone polls GET /api/mobile/auth/check?code=DAZ-7K3M and receives the
//    bearer token exactly once. The browser never sees the token.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { nowIso } from "@/lib/receipts/db-utils";
import {
  DEFAULT_MOBILE_SCOPES,
  enrollMobileDevice,
  type MobileScope,
} from "@/lib/receipts/trusted-devices";

const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1
const CODE_PREFIX = "DAZ";
const CODE_DIGITS = 4;

export interface PairingCodeRow {
  code: string;
  created_at: string;
  expires_at: string;
  consumed_device_id: string | null;
  consumed_at: string | null;
  bearer_token: string | null;
}

function randomCode(): string {
  const buf = new Uint8Array(CODE_DIGITS);
  crypto.getRandomValues(buf);
  let body = "";
  for (let i = 0; i < CODE_DIGITS; i += 1) {
    body += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  }
  return `${CODE_PREFIX}-${body}`;
}

export function isValidPairingCodeShape(code: string): boolean {
  return /^DAZ-[A-Z0-9]{4}$/.test(code);
}

export async function createPairingCode(): Promise<{ code: string; expiresAt: string }> {
  const db = getReceiptsDb();
  const now = Date.now();
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  const createdAt = new Date(now).toISOString();

  // Try up to 5 times to dodge a collision against an active (unconsumed,
  // unexpired) code. Total entropy of the alphabet × digit count makes
  // collisions extremely rare in practice.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    try {
      await db
        .prepare(
          `INSERT INTO mobile_pairing_codes (code, created_at, expires_at)
           VALUES (?, ?, ?)`,
        )
        .bind(code, createdAt, expiresAt)
        .run();
      return { code, expiresAt };
    } catch (err) {
      // PRIMARY KEY collision → retry. Other errors should surface.
      if (err instanceof Error && /UNIQUE|PRIMARY/i.test(err.message)) continue;
      throw err;
    }
  }
  throw new Error("Failed to allocate pairing code after retries.");
}

export interface CompletePairingInput {
  code: string;
  actor: string;
  label: string;
  userAgent: string | null;
  platform: "ios" | "android";
  appVersion: string | null;
  scopes?: MobileScope[];
}

// Atomically consume a pairing code and enroll a mobile device. The bearer
// token is stashed in mobile_pairing_codes.bearer_token so the polling iPhone
// can retrieve it via /check. The browser never sees the token.
export async function completePairing(
  input: CompletePairingInput,
): Promise<{ deviceId: string }> {
  const normalized = input.code.trim().toUpperCase();
  if (!isValidPairingCodeShape(normalized)) {
    throw new Error("Invalid pairing code format.");
  }

  const db = getReceiptsDb();
  const row = await db
    .prepare(
      `SELECT code, created_at, expires_at, consumed_device_id
       FROM mobile_pairing_codes WHERE code = ? LIMIT 1`,
    )
    .bind(normalized)
    .first<{
      code: string;
      created_at: string;
      expires_at: string;
      consumed_device_id: string | null;
    }>();

  if (!row) throw new Error("Pairing code not found.");
  if (row.consumed_device_id) throw new Error("Pairing code already used.");
  if (Date.parse(row.expires_at) < Date.now()) {
    throw new Error("Pairing code has expired.");
  }

  const { id: deviceId, bearerToken } = await enrollMobileDevice({
    actor: input.actor,
    label: input.label,
    userAgent: input.userAgent,
    platform: input.platform,
    appVersion: input.appVersion,
    scopes: input.scopes ?? DEFAULT_MOBILE_SCOPES,
  });

  // Stash the token on the code row so the polling client can read it. Use a
  // conditional UPDATE so two concurrent /complete-pairing calls cannot both
  // consume the same code; the loser sees affected_rows = 0 and we revoke
  // the second device immediately.
  const update = await db
    .prepare(
      `UPDATE mobile_pairing_codes
         SET consumed_device_id = ?,
             consumed_at = ?,
             bearer_token = ?
       WHERE code = ? AND consumed_device_id IS NULL`,
    )
    .bind(deviceId, nowIso(), bearerToken, normalized)
    .run();

  // D1 returns meta.changes for affected rows.
  const changes = Number(update.meta?.changes ?? 0);
  if (changes === 0) {
    // Race lost — revoke this device and surface the failure.
    await db
      .prepare(`UPDATE trusted_devices SET revoked_at = ? WHERE id = ?`)
      .bind(nowIso(), deviceId)
      .run();
    throw new Error("Pairing code already used.");
  }

  return { deviceId };
}

// Polling endpoint result. Bearer token is returned exactly once: the row is
// cleared after a successful read so the token cannot be replayed.
export async function checkPairingCode(code: string): Promise<
  | { status: "pending" }
  | { status: "expired" }
  | { status: "ready"; bearerToken: string; deviceId: string }
  | { status: "not_found" }
> {
  const normalized = code.trim().toUpperCase();
  if (!isValidPairingCodeShape(normalized)) return { status: "not_found" };

  const db = getReceiptsDb();
  const row = await db
    .prepare(
      `SELECT expires_at, consumed_device_id, bearer_token
       FROM mobile_pairing_codes WHERE code = ? LIMIT 1`,
    )
    .bind(normalized)
    .first<{
      expires_at: string;
      consumed_device_id: string | null;
      bearer_token: string | null;
    }>();

  if (!row) return { status: "not_found" };

  if (!row.consumed_device_id) {
    if (Date.parse(row.expires_at) < Date.now()) return { status: "expired" };
    return { status: "pending" };
  }

  if (!row.bearer_token) {
    // Already delivered.
    return { status: "not_found" };
  }

  await db
    .prepare(
      `UPDATE mobile_pairing_codes SET bearer_token = NULL WHERE code = ?`,
    )
    .bind(normalized)
    .run();

  return {
    status: "ready",
    bearerToken: row.bearer_token,
    deviceId: row.consumed_device_id,
  };
}

export async function deleteExpiredPairingCodes(): Promise<void> {
  const db = getReceiptsDb();
  await db
    .prepare(
      `DELETE FROM mobile_pairing_codes
       WHERE (consumed_device_id IS NULL AND expires_at < ?)
          OR (consumed_at IS NOT NULL AND bearer_token IS NULL AND consumed_at < ?)`,
    )
    .bind(nowIso(), new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .run();
}
