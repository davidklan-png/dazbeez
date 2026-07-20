// ADR 0011 Phase B follow-up: the email-body auto-promote allowlist, managed
// from a Settings page (trusted_intake_senders table). Previously a
// TRUSTED_INTAKE_SENDERS env var in the Mac consumer; now D1-backed so David can
// add/remove addresses from the app without touching a Worker secret.
//
// This list IS the single safety gate for a zero-human-review auto-promotion
// path (only these senders, with SPF+DKIM, auto-file body-only receipts), so
// every add/remove is audit-logged.
//
// `db` is an injected param (the recordIntake/testability precedent), not a
// module-level getReceiptsDb() call — so the add/list/remove round-trip is
// unit-testable with a fake D1. Callers pass getReceiptsDb().

import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";

export interface TrustedIntakeSender {
  email: string;
  added_by: string;
  created_at: string;
}

// "Obviously malformed" rejector — not an RFC 5322 validator. Requires non-empty
// local@domain.tld with no whitespace. Same shape as the compliance route's
// notification_recipient check.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase, the single normalization applied at write time so the
 * consumer's eligibility check is a plain set-membership test at read time. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidSenderEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export async function listTrustedSenders(
  db: D1Database,
): Promise<TrustedIntakeSender[]> {
  const result = await db
    .prepare(
      `SELECT email, added_by, created_at
         FROM trusted_intake_senders
        ORDER BY created_at ASC`,
    )
    .all<TrustedIntakeSender>();
  return result.results ?? [];
}

/**
 * Add a sender to the auto-promote allowlist. Idempotent: adding an
 * already-present address is a silent no-op (no error, no audit entry — the
 * list is unchanged). Rejects obviously-malformed input with a thrown Error
 * whose message is safe to surface to the operator.
 */
export async function addTrustedSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!isValidSenderEmail(normalized)) {
    throw new Error(
      `"${email.trim()}" is not a valid email address (expected local@domain.tld, no spaces).`,
    );
  }

  const existing = await db
    .prepare(`SELECT 1 FROM trusted_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();

  if (existing) {
    // Idempotent: already on the list, nothing to do (no duplicate audit entry).
    return;
  }

  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO trusted_intake_senders (email, added_by, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO NOTHING`,
    )
    .bind(normalized, actor, now)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "trusted_sender.added",
    objectType: "trusted_sender",
    objectId: normalized,
    newValueJson: stringifyJson({ email: normalized }),
  });
}

/**
 * Remove a sender from the allowlist. Email is normalized before lookup. A
 * no-op (no error, no audit) if the address wasn't present.
 */
export async function removeTrustedSender(
  db: D1Database,
  email: string,
  actor: string,
): Promise<void> {
  const normalized = normalizeEmail(email);

  const existing = await db
    .prepare(`SELECT 1 FROM trusted_intake_senders WHERE email = ? LIMIT 1`)
    .bind(normalized)
    .first();

  if (!existing) {
    return; // not present — idempotent no-op
  }

  await db
    .prepare(`DELETE FROM trusted_intake_senders WHERE email = ?`)
    .bind(normalized)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "trusted_sender.removed",
    objectType: "trusted_sender",
    objectId: normalized,
    oldValueJson: stringifyJson({ email: normalized }),
  });
}

