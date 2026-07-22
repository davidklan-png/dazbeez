// ADR 0011 follow-up (2026-07-22): sender-policy transitions and shared state.
//
// ALL mutations (Trust/Block/Untrust/Unblock) go through this module. Each
// transition is ONE D1 batch containing both the mutation AND the conditional
// audit INSERTs — so if any statement fails the entire transition rolls back
// (mutation + audit are atomic). No post-batch audit writes.
//
// Concurrency-safe: trustSender unconditionally DELETEs any blocked row and
// INSERTs the trusted row (ON CONFLICT DO NOTHING) in the same batch.
// blockSender is symmetric. D1 serializes batches, so whichever complete
// transition runs last owns the final state.

import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, newUuid, stringifyJson } from "@/lib/receipts/db-utils";
import {
  normalizeSenderEmail,
  isValidSenderEmail,
} from "@/lib/receipts/trusted-senders";

export type SenderState = "trusted" | "blocked" | "unrecognized";

export { normalizeSenderEmail };

export async function resolveSenderState(
  db: D1Database,
  email: string,
): Promise<SenderState> {
  const normalized = normalizeSenderEmail(email);
  const blocked = await db
    .prepare(`SELECT 1 FROM blocked_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();
  if (blocked) return "blocked";
  const trusted = await db
    .prepare(`SELECT 1 FROM trusted_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();
  return trusted ? "trusted" : "unrecognized";
}

/**
 * Generate an audit INSERT prepared statement that fires ONLY if a condition
 * subquery matches. Uses INSERT ... SELECT ... WHERE EXISTS/NOT EXISTS so the
 * audit is in the SAME batch as the mutation (atomic). The UUID + timestamp
 * are generated before the batch (not from SQL functions) so they're stable.
 */
function conditionalAuditStmt(
  db: D1Database,
  params: {
    uuid: string;
    actor: string;
    action: string;
    objectType: string;
    objectId: string;
    valueJson: string | null;
    isNew: boolean; // true → new_value_json, false → old_value_json
    timestamp: string;
  },
  conditionSql: string,
  conditionBinds: unknown[],
): D1PreparedStatement {
  const jsonCol = params.isNew ? "new_value_json" : "old_value_json";
  const otherCol = params.isNew ? "old_value_json" : "new_value_json";
  return db
    .prepare(
      `INSERT INTO receipt_audit_log
        (id, actor, action, object_type, object_id, ${jsonCol}, ${otherCol}, created_at)
       SELECT ?, ?, ?, ?, ?, ?, NULL, ?
       WHERE EXISTS (${conditionSql})`,
    )
    .bind(
      params.uuid,
      params.actor,
      params.action,
      params.objectType,
      params.objectId,
      params.valueJson,
      params.timestamp,
      ...conditionBinds,
    );
}

/**
 * Trust a sender. ONE atomic batch:
 *   1. Audit blocked_sender.removed IF a blocked row currently exists.
 *   2. DELETE the blocked row.
 *   3. Audit trusted_sender.added IF the trusted row does NOT exist.
 *   4. INSERT the trusted row (ON CONFLICT DO NOTHING — preserves created_at).
 */
export async function trustSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<void> {
  const normalized = normalizeSenderEmail(email);
  if (!isValidSenderEmail(normalized)) {
    throw new Error(
      `"${email.trim()}" is not a valid email address (expected local@domain.tld, no spaces).`,
    );
  }

  const now = nowIso();
  const json = stringifyJson({ email: normalized });

  await db.batch([
    // 1. Audit blocked removal IF blocked row exists.
    conditionalAuditStmt(
      db,
      { uuid: newUuid(), actor, action: "blocked_sender.removed", objectType: "blocked_sender", objectId: normalized, valueJson: json, isNew: false, timestamp: now },
      `SELECT 1 FROM blocked_intake_senders WHERE email = ?`,
      [normalized],
    ),
    // 2. Delete blocked row.
    db.prepare(`DELETE FROM blocked_intake_senders WHERE email = ?`).bind(normalized),
    // 3. Audit trusted addition IF trusted row does NOT exist.
    conditionalAuditStmt(
      db,
      { uuid: newUuid(), actor, action: "trusted_sender.added", objectType: "trusted_sender", objectId: normalized, valueJson: json, isNew: true, timestamp: now },
      `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM trusted_intake_senders WHERE email = ?)`,
      [normalized],
    ),
    // 4. Insert trusted row (preserves created_at on conflict).
    db
      .prepare(
        `INSERT INTO trusted_intake_senders (email, added_by, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(normalized, actor, now),
  ]);
}

/**
 * Block a sender. ONE atomic batch (symmetric to trustSender):
 *   1. Audit trusted_sender.removed IF a trusted row exists.
 *   2. DELETE the trusted row.
 *   3. Audit blocked_sender.added IF the blocked row does NOT exist.
 *   4. INSERT the blocked row (ON CONFLICT DO NOTHING).
 */
export async function blockSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<void> {
  const normalized = normalizeSenderEmail(email);
  if (!isValidSenderEmail(normalized)) {
    throw new Error(
      `"${email.trim()}" is not a valid email address (expected local@domain.tld, no spaces).`,
    );
  }

  const now = nowIso();
  const json = stringifyJson({ email: normalized });

  await db.batch([
    conditionalAuditStmt(
      db,
      { uuid: newUuid(), actor, action: "trusted_sender.removed", objectType: "trusted_sender", objectId: normalized, valueJson: json, isNew: false, timestamp: now },
      `SELECT 1 FROM trusted_intake_senders WHERE email = ?`,
      [normalized],
    ),
    db.prepare(`DELETE FROM trusted_intake_senders WHERE email = ?`).bind(normalized),
    conditionalAuditStmt(
      db,
      { uuid: newUuid(), actor, action: "blocked_sender.added", objectType: "blocked_sender", objectId: normalized, valueJson: json, isNew: true, timestamp: now },
      `SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM blocked_intake_senders WHERE email = ?)`,
      [normalized],
    ),
    db
      .prepare(
        `INSERT INTO blocked_intake_senders (email, blocked_by, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(normalized, actor, now),
  ]);
}

/**
 * Untrust a sender. ONE atomic batch:
 *   1. Audit trusted_sender.removed IF the row exists.
 *   2. DELETE the row.
 */
export async function untrustSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<void> {
  const normalized = normalizeSenderEmail(email);
  const now = nowIso();
  const json = stringifyJson({ email: normalized });

  await db.batch([
    conditionalAuditStmt(
      db,
      { uuid: newUuid(), actor, action: "trusted_sender.removed", objectType: "trusted_sender", objectId: normalized, valueJson: json, isNew: false, timestamp: now },
      `SELECT 1 FROM trusted_intake_senders WHERE email = ?`,
      [normalized],
    ),
    db.prepare(`DELETE FROM trusted_intake_senders WHERE email = ?`).bind(normalized),
  ]);
}

/**
 * Unblock a sender. ONE atomic batch:
 *   1. Audit blocked_sender.removed IF the row exists.
 *   2. DELETE the row.
 */
export async function unblockSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<void> {
  const normalized = normalizeSenderEmail(email);
  const now = nowIso();
  const json = stringifyJson({ email: normalized });

  await db.batch([
    conditionalAuditStmt(
      db,
      { uuid: newUuid(), actor, action: "blocked_sender.removed", objectType: "blocked_sender", objectId: normalized, valueJson: json, isNew: false, timestamp: now },
      `SELECT 1 FROM blocked_intake_senders WHERE email = ?`,
      [normalized],
    ),
    db.prepare(`DELETE FROM blocked_intake_senders WHERE email = ?`).bind(normalized),
  ]);
}
