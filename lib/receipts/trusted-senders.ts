// ADR 0011 Phase B: the email-body auto-promote allowlist (trusted_intake_senders
// table). Read/list helpers + shared normalization. ALL mutations (trust/block/
// untrust/unblock) live in sender-policy.ts to enforce mutual exclusion.

export interface TrustedIntakeSender {
  email: string;
  added_by: string;
  created_at: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase — shared by trusted AND blocked sender policy code. */
export function normalizeSenderEmail(email: string): string {
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
