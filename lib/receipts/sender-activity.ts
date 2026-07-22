// ADR 0011 follow-up (2026-07-22): sender activity aggregation + snapshot.
// Uses NOT EXISTS (not NOT IN) for exclusion so NULL policy rows can't suppress
// results. Selects only counts/timestamps — never bodies, headers, subjects,
// or attachment contents.

import type { TrustedIntakeSender } from "@/lib/receipts/trusted-senders";
import type { BlockedIntakeSender } from "@/lib/receipts/blocked-senders";
import { listTrustedSenders } from "@/lib/receipts/trusted-senders";
import { listBlockedSenders } from "@/lib/receipts/blocked-senders";

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

export interface BlockedSenderWithActivity extends BlockedIntakeSender {
  blocked_delivery_count: number;
  latest_blocked_delivery: string | null;
}

/**
 * List unrecognized senders: groups from email_receipt_intake that are NOT in
 * trusted_intake_senders AND NOT in blocked_intake_senders. Exclusion is in
 * SQL via NOT EXISTS (not NOT IN) so NULL policy rows can't suppress results.
 * Bounded to the 50 most recently active groups.
 */
export async function listUnrecognizedSenders(
  db: D1Database,
  limit = 50,
): Promise<SenderActivityGroup[]> {
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
       FROM email_receipt_intake e
       WHERE NOT EXISTS (SELECT 1 FROM trusted_intake_senders t WHERE t.email = LOWER(TRIM(e.from_address)))
         AND NOT EXISTS (SELECT 1 FROM blocked_intake_senders b WHERE b.email = LOWER(TRIM(e.from_address)))
       GROUP BY LOWER(TRIM(from_address))
       ORDER BY latest_received DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<SenderActivityGroup & { addr: string }>();

  return (result.results ?? []).map((r) => ({
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

/**
 * Enrich blocked senders with delivery-attempt activity (count + latest) from
 * email_receipt_intake.blocked_sender_email. Historical rows (NULL
 * blocked_sender_email) do not count.
 */
async function enrichBlockedWithActivity(
  db: D1Database,
  blocked: BlockedIntakeSender[],
): Promise<BlockedSenderWithActivity[]> {
  if (blocked.length === 0) return [];
  const emails = blocked.map((b) => b.email);
  const placeholders = emails.map(() => "?").join(",");
  const activityRows = await db
    .prepare(
      `SELECT blocked_sender_email AS email,
              COUNT(*) AS cnt,
              MAX(received_at) AS latest
         FROM email_receipt_intake
        WHERE blocked_sender_email IN (${placeholders})
        GROUP BY blocked_sender_email`,
    )
    .bind(...emails)
    .all<{ email: string; cnt: number; latest: string | null }>();

  const activityMap = new Map(
    (activityRows.results ?? []).map((r) => [r.email, { cnt: r.cnt, latest: r.latest }]),
  );

  return blocked.map((b) => {
    const act = activityMap.get(b.email);
    return {
      ...b,
      blocked_delivery_count: act?.cnt ?? 0,
      latest_blocked_delivery: act?.latest ?? null,
    };
  });
}

/**
 * The authoritative sender-controls snapshot: all three lists in one response.
 * Returned after every Settings mutation so the client replaces all three
 * collections atomically.
 */
export async function getSenderControlsSnapshot(db: D1Database): Promise<{
  trusted: TrustedIntakeSender[];
  blocked: BlockedSenderWithActivity[];
  unrecognized: SenderActivityGroup[];
}> {
  const [trusted, blocked] = await Promise.all([
    listTrustedSenders(db),
    listBlockedSenders(db),
  ]);
  const blockedWithActivity = await enrichBlockedWithActivity(db, blocked);
  const unrecognized = await listUnrecognizedSenders(db);
  return { trusted, blocked: blockedWithActivity, unrecognized };
}
