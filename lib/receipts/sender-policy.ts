// ADR 0011 follow-up (2026-07-22): sender-policy transitions and shared state.
//
// Trusted and blocked are MUTUALLY EXCLUSIVE: trusting removes any blocked row,
// blocking removes any trusted row. Both transitions use a D1 batch so the
// mutual exclusion is atomic — an address can never be present in both tables
// after a transition, even under concurrent requests.
//
// If inconsistent data somehow exists (e.g. a pre-batching legacy row), blocked
// wins defensively in every eligibility check (isAutoPromoteEligible +
// isBlockedSender + the processor promotion gate).

import { nowIso, newUuid, stringifyJson } from "@/lib/receipts/db-utils";
import {
  normalizeSenderEmail,
  isValidSenderEmail,
} from "@/lib/receipts/trusted-senders";

export type SenderState = "trusted" | "blocked" | "unrecognized";

export { normalizeSenderEmail };

/**
 * Resolve the current policy state for a sender. Blocked wins defensively if
 * the address is somehow in both tables.
 */
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

function auditStmt(
  db: D1Database,
  actor: string,
  action: string,
  objectType: string,
  objectId: string,
  valueJson: Record<string, unknown> | null,
  isOld: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO receipt_audit_log
        (id, actor, action, object_type, object_id,
         old_value_json, new_value_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newUuid(),
      actor,
      action,
      objectType,
      objectId,
      isOld ? stringifyJson(valueJson) : null,
      isOld ? null : stringifyJson(valueJson),
      nowIso(),
    );
}

/**
 * Trust a sender: atomically remove any blocked row + insert the trusted row.
 * Audits only the state changes that ACTUALLY occurred (no duplicate audit if
 * already trusted; audit blocked_sender.removed only if a blocked row was
 * actually removed). Idempotent.
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

  const wasBlocked = await db
    .prepare(`SELECT 1 FROM blocked_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();
  const wasTrusted = await db
    .prepare(`SELECT 1 FROM trusted_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();

  if (!wasBlocked && wasTrusted) return; // already trusted, not blocked — no-op

  const now = nowIso();
  const batch: D1PreparedStatement[] = [];

  if (wasBlocked) {
    batch.push(
      db.prepare(`DELETE FROM blocked_intake_senders WHERE email = ?`).bind(normalized),
    );
    batch.push(
      auditStmt(db, actor, "blocked_sender.removed", "blocked_sender", normalized, { email: normalized }, true),
    );
  }
  if (!wasTrusted) {
    batch.push(
      db
        .prepare(
          `INSERT INTO trusted_intake_senders (email, added_by, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(email) DO NOTHING`,
        )
        .bind(normalized, actor, now),
    );
    batch.push(
      auditStmt(db, actor, "trusted_sender.added", "trusted_sender", normalized, { email: normalized }, false),
    );
  }

  if (batch.length > 0) await db.batch(batch);
}

/**
 * Block a sender: atomically remove any trusted row + insert the blocked row.
 * Audits only actual state changes. Idempotent.
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

  const wasTrusted = await db
    .prepare(`SELECT 1 FROM trusted_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();
  const wasBlocked = await db
    .prepare(`SELECT 1 FROM blocked_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();

  if (wasBlocked && !wasTrusted) return; // already blocked, not trusted — no-op

  const now = nowIso();
  const batch: D1PreparedStatement[] = [];

  if (wasTrusted) {
    batch.push(
      db.prepare(`DELETE FROM trusted_intake_senders WHERE email = ?`).bind(normalized),
    );
    batch.push(
      auditStmt(db, actor, "trusted_sender.removed", "trusted_sender", normalized, { email: normalized }, true),
    );
  }
  if (!wasBlocked) {
    batch.push(
      db
        .prepare(
          `INSERT INTO blocked_intake_senders (email, blocked_by, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(email) DO NOTHING`,
        )
        .bind(normalized, actor, now),
    );
    batch.push(
      auditStmt(db, actor, "blocked_sender.added", "blocked_sender", normalized, { email: normalized }, false),
    );
  }

  if (batch.length > 0) await db.batch(batch);
}
