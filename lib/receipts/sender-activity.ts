// ADR 0011 follow-up (2026-07-22): bounded aggregation of unrecognized sender
// activity. Excludes trusted and blocked senders IN SQL (NOT EXISTS) before
// ORDER BY + LIMIT, so the 50 newest unrecognized groups are always correct
// regardless of how many recognized groups exist. Selects only counts and
// timestamps — never bodies, raw headers, subjects, or attachment contents.

export interface SenderActivityGroup {
  from_address: string;
  first_received: string;
  latest_received: string;
  total: number;
  pending: number;
  promoted: number;
  rejected: number;
  spf_pass_any: number;
  spf_fail_any: number;
  dkim_pass_any: number;
  dkim_fail_any: number;
}

import type { TrustedIntakeSender } from "@/lib/receipts/trusted-senders";
import type { BlockedIntakeSender } from "@/lib/receipts/blocked-senders";
import { listTrustedSenders } from "@/lib/receipts/trusted-senders";
import { listBlockedSenders } from "@/lib/receipts/blocked-senders";

/**
 * The authoritative sender-controls snapshot: all three lists in one response.
 * Returned after every Settings mutation so the client replaces all three
 * collections atomically (no stale local state drift).
 */
export async function getSenderControlsSnapshot(db: D1Database): Promise<{
  trusted: TrustedIntakeSender[];
  blocked: BlockedIntakeSender[];
  unrecognized: SenderActivityGroup[];
}> {
  const [trusted, blocked] = await Promise.all([
    listTrustedSenders(db),
    listBlockedSenders(db),
  ]);
  const unrecognized = await listUnrecognizedSenders(
    db,
    trusted.map((t) => t.email),
    blocked.map((b) => b.email),
  );
  return { trusted, blocked, unrecognized };
}

export async function listUnrecognizedSenders(
  db: D1Database,
  _trustedEmails: readonly string[],
  _blockedEmails: readonly string[],
  limit = 50,
): Promise<SenderActivityGroup[]> {
  // Exclusion is done IN SQL via NOT EXISTS (not application-level filtering)
  // so the LIMIT 50 is applied AFTER excluding recognized senders.
  const result = await db
    .prepare(
      `SELECT
         LOWER(TRIM(from_address)) AS addr,
         MIN(received_at)    AS first_received,
         MAX(received_at)    AS latest_received,
         COUNT(*)            AS total,
         SUM(CASE WHEN status = 'pending_triage' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'promoted' THEN 1 ELSE 0 END)       AS promoted,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END)       AS rejected,
         SUM(CASE WHEN spf_pass = 1 THEN 1 ELSE 0 END)  AS spf_pass_any,
         SUM(CASE WHEN spf_pass = 0 THEN 1 ELSE 0 END)  AS spf_fail_any,
         SUM(CASE WHEN dkim_pass = 1 THEN 1 ELSE 0 END) AS dkim_pass_any,
         SUM(CASE WHEN dkim_pass = 0 THEN 1 ELSE 0 END) AS dkim_fail_any
       FROM email_receipt_intake
       WHERE LOWER(TRIM(from_address)) NOT IN (SELECT email FROM trusted_intake_senders)
         AND LOWER(TRIM(from_address)) NOT IN (SELECT email FROM blocked_intake_senders)
       GROUP BY LOWER(TRIM(from_address))
       ORDER BY latest_received DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<SenderActivityGroup & { addr: string }>();

  const rows = (result.results ?? []) as Array<
    SenderActivityGroup & { addr: string }
  >;
  return rows.map((r) => ({
    from_address: r.addr,
    first_received: r.first_received,
    latest_received: r.latest_received,
    total: r.total,
    pending: r.pending,
    promoted: r.promoted,
    rejected: r.rejected,
    spf_pass_any: r.spf_pass_any,
    spf_fail_any: r.spf_fail_any,
    dkim_pass_any: r.dkim_pass_any,
    dkim_fail_any: r.dkim_fail_any,
  }));
}
