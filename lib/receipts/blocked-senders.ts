// ADR 0011 follow-up (2026-07-22): operator-managed sender blocklist.
//
// Mirrors trusted-senders.ts (same normalization, idempotent add/remove,
// per-entry audit). Mutually exclusive with trusted_intake_senders at the
// policy layer (see sender-policy.ts transitions); if inconsistent data
// somehow exists in both tables, blocked wins defensively in every
// eligibility check.
//
// `db` is injected (same testability precedent as trusted-senders).

import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { normalizeSenderEmail, isValidSenderEmail } from "@/lib/receipts/trusted-senders";

export interface BlockedIntakeSender {
  email: string;
  blocked_by: string;
  created_at: string;
}

export async function listBlockedSenders(
  db: D1Database,
): Promise<BlockedIntakeSender[]> {
  const result = await db
    .prepare(
      `SELECT email, blocked_by, created_at
         FROM blocked_intake_senders
        ORDER BY created_at ASC`,
    )
    .all<BlockedIntakeSender>();
  return result.results ?? [];
}

/** True if the normalized address is on the blocklist. Used by the Worker
 *  (before reading raw), the consumer, and the processor promotion gate. */
export async function isBlockedSender(
  db: D1Database,
  email: string,
): Promise<boolean> {
  const normalized = normalizeSenderEmail(email);
  const row = await db
    .prepare(`SELECT 1 FROM blocked_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();
  return !!row;
}

/**
 * Add a sender to the blocklist. Idempotent (ON CONFLICT DO NOTHING; audit only
 * on actual insertion). Returns true if a new row was created.
 */
export async function addBlockedSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<boolean> {
  const normalized = normalizeSenderEmail(email);
  if (!isValidSenderEmail(normalized)) {
    throw new Error(
      `"${email.trim()}" is not a valid email address (expected local@domain.tld, no spaces).`,
    );
  }
  const existing = await db
    .prepare(`SELECT 1 FROM blocked_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();
  if (existing) return false; // idempotent

  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO blocked_intake_senders (email, blocked_by, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO NOTHING`,
    )
    .bind(normalized, actor, now)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "blocked_sender.added",
    objectType: "blocked_sender",
    objectId: normalized,
    newValueJson: stringifyJson({ email: normalized }),
  });
  return true;
}

/**
 * Remove a sender from the blocklist. Idempotent (no error, no audit if absent).
 * Returns true if a row was actually removed.
 */
export async function removeBlockedSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<boolean> {
  const normalized = normalizeSenderEmail(email);
  const existing = await db
    .prepare(`SELECT 1 FROM blocked_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();
  if (!existing) return false;

  await db
    .prepare(`DELETE FROM blocked_intake_senders WHERE email = ?`)
    .bind(normalized)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "blocked_sender.removed",
    objectType: "blocked_sender",
    objectId: normalized,
    oldValueJson: stringifyJson({ email: normalized }),
  });
  return true;
}
