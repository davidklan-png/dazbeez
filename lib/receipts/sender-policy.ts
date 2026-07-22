// ADR 0011 follow-up (2026-07-22): sender-policy transitions and shared state.
//
// Trusted and blocked are MUTUALLY EXCLUSIVE. ALL mutations go through this
// module — the add/remove helpers in trusted-senders.ts and blocked-senders.ts
// are read/list only. This centralizes the mutual-exclusion guarantee so no
// caller can bypass it.
//
// Concurrency-safe algorithm: each transition unconditionally DELETEs the
// counterpart row and INSERTs its own row with ON CONFLICT DO NOTHING, all in
// one D1 batch. D1 serializes each batch, so whichever complete transition
// runs last owns the final state — two concurrent opposite transitions cannot
// leave an address in both tables. Audit entries are emitted based on the
// ACTUAL change counts from the batch results (not stale pre-batch reads).

import { createAuditEntry } from "@/lib/receipts/audit";
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

/**
 * Trust a sender: unconditionally DELETE any blocked row + INSERT the trusted
 * row (ON CONFLICT DO NOTHING preserves the original created_at on idempotent
 * re-trust). Audits only state changes that ACTUALLY occurred (based on the
 * batch change counts). Concurrency-safe: two concurrent trustSender calls
 * produce one trusted row; a concurrent trustSender + blockSender ends in
 * exactly one state (whichever batch runs last).
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
  const results = await db.batch([
    db.prepare(`DELETE FROM blocked_intake_senders WHERE email = ?`).bind(normalized),
    db
      .prepare(
        `INSERT INTO trusted_intake_senders (email, added_by, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(normalized, actor, now),
  ]);

  const blockedRemoved = results[0]?.meta?.changes ?? 0;
  const trustedAdded = results[1]?.meta?.changes ?? 0;

  if (blockedRemoved > 0) {
    await createAuditEntry(db, {
      actor,
      action: "blocked_sender.removed",
      objectType: "blocked_sender",
      objectId: normalized,
      oldValueJson: stringifyJson({ email: normalized }),
    });
  }
  if (trustedAdded > 0) {
    await createAuditEntry(db, {
      actor,
      action: "trusted_sender.added",
      objectType: "trusted_sender",
      objectId: normalized,
      newValueJson: stringifyJson({ email: normalized }),
    });
  }
}

/**
 * Block a sender: unconditionally DELETE any trusted row + INSERT the blocked
 * row (ON CONFLICT DO NOTHING). Audits only actual changes.
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
  const results = await db.batch([
    db.prepare(`DELETE FROM trusted_intake_senders WHERE email = ?`).bind(normalized),
    db
      .prepare(
        `INSERT INTO blocked_intake_senders (email, blocked_by, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(email) DO NOTHING`,
      )
      .bind(normalized, actor, now),
  ]);

  const trustedRemoved = results[0]?.meta?.changes ?? 0;
  const blockedAdded = results[1]?.meta?.changes ?? 0;

  if (trustedRemoved > 0) {
    await createAuditEntry(db, {
      actor,
      action: "trusted_sender.removed",
      objectType: "trusted_sender",
      objectId: normalized,
      oldValueJson: stringifyJson({ email: normalized }),
    });
  }
  if (blockedAdded > 0) {
    await createAuditEntry(db, {
      actor,
      action: "blocked_sender.added",
      objectType: "blocked_sender",
      objectId: normalized,
      newValueJson: stringifyJson({ email: normalized }),
    });
  }
}

/**
 * Remove a sender from the trusted list (untrust). Idempotent; audits only if
 * a row was actually removed.
 */
export async function untrustSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<void> {
  const normalized = normalizeSenderEmail(email);
  const result = await db
    .prepare(`DELETE FROM trusted_intake_senders WHERE email = ?`)
    .bind(normalized)
    .run();

  if ((result.meta?.changes ?? 0) > 0) {
    await createAuditEntry(db, {
      actor,
      action: "trusted_sender.removed",
      objectType: "trusted_sender",
      objectId: normalized,
      oldValueJson: stringifyJson({ email: normalized }),
    });
  }
}

/**
 * Remove a sender from the blocklist (unblock). Idempotent; audits only if a
 * row was actually removed.
 */
export async function unblockSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<void> {
  const normalized = normalizeSenderEmail(email);
  const result = await db
    .prepare(`DELETE FROM blocked_intake_senders WHERE email = ?`)
    .bind(normalized)
    .run();

  if ((result.meta?.changes ?? 0) > 0) {
    await createAuditEntry(db, {
      actor,
      action: "blocked_sender.removed",
      objectType: "blocked_sender",
      objectId: normalized,
      oldValueJson: stringifyJson({ email: normalized }),
    });
  }
}
