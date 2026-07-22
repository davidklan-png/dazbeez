// ADR 0011 follow-up (2026-07-22): operator-managed sender blocklist.
// Read/list helpers only. ALL mutations go through sender-policy.ts.

import { normalizeSenderEmail } from "@/lib/receipts/trusted-senders";

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

/** True if the normalized address is on the blocklist. */
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
