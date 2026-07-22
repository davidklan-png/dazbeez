// ADR 0011 follow-up (2026-07-22): bounded aggregation of unrecognized sender
// activity for the Settings "Recent unrecognized senders" section. Derived from
// email_receipt_intake; excludes currently trusted and blocked senders; bounded
// to the 50 most recently active sender groups. Does NOT select bodies, raw
// headers, or attachment contents — only counts, timestamps, and auth verdicts.

import { normalizeSenderEmail } from "@/lib/receipts/trusted-senders";

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

export async function listUnrecognizedSenders(
  db: D1Database,
  trustedEmails: readonly string[],
  blockedEmails: readonly string[],
  limit = 50,
): Promise<SenderActivityGroup[]> {
  const trusted = new Set(trustedEmails.map((e) => normalizeSenderEmail(e)));
  const blocked = new Set(blockedEmails.map((e) => normalizeSenderEmail(e)));

  const result = await db
    .prepare(
      `SELECT
         LOWER(from_address) AS addr,
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
       GROUP BY LOWER(from_address)
       ORDER BY latest_received DESC
       LIMIT ?`,
    )
    .bind(Math.min(limit * 4, 200)) // over-fetch to allow post-filter exclusion
    .all<SenderActivityGroup & { addr: string }>();

  const rows = (result.results ?? []) as Array<
    SenderActivityGroup & { addr: string }
  >;
  return rows
    .filter((r) => r.addr && !trusted.has(r.addr) && !blocked.has(r.addr))
    .map((r) => ({
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
    }))
    .slice(0, limit);
}
