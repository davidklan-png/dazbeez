#!/usr/bin/env -S npx tsx
// One-off: correct the OCR decade-slip on two receipts whose printed date was
// read as 2016-MM-DD by Google Vision OCR but are 2026 receipts (captured
// 2026-05; the printed weekday (月)=Monday matches the 2026 date, not 2016;
// AMEX charges being reconciled in 2026). Operator-directed (decision rule in
// prompts/WORKER-PROMPT-deploy-review-ux-and-2016-fix.md §A1): correct the YEAR ONLY.
//
// WHERE THIS RUNS: the Mac, with live Cloudflare bindings — it shells out to
// `wrangler d1 execute RECEIPTS_DB --remote`. Dry-run by default; --write to
// persist. Run: `npx tsx scripts/fix-2016-date-anomaly.ts [--write]`.
//
// WHY HAND-WRITTEN (not updateReceiptRecord): the app's updateReceiptRecord
// resolves its D1 binding via getCloudflareContext(), which needs the OpenNext
// Worker async context — unavailable in a standalone tsx script targeting
// REMOTE D1 (no existing script/ bootstraps it; wrangler's local proxy is
// local-only). So this replicates updateReceiptRecord's exact effect for an
// AMEX date-only change:
//   - recon-sealed gate: PASS (both receipts are unmatched AMEX — verified
//     no amex_statement_lines.matched_receipt_id);
//   - export gate: N/A (AMEX skips it; 2026-03 has no export row anyway);
//   - UPDATE transaction_date + updated_at;
//   - one receipt.updated audit row (old = full before row, new = {transactionDate});
//   - membership hook: NO-OP for AMEX (assignMembershipForReceipt is CASH/DIGITAL).
// The recon/export pre-checks are re-asserted at runtime below as a guardrail.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const DB = "RECEIPTS_DB";
const ACTOR = "fix-2016-date-anomaly.ts (operator-directed year correction)";
const WRITE = process.argv.slice(2).includes("--write");

const TARGETS: Array<{ id: string; from: string; to: string }> = [
  { id: "43ff9e8a-2744-4edc-ada7-a1a473a8dc85", from: "2016-03-09", to: "2026-03-09" },
  { id: "d554e7e6-e5d3-40e8-8999-4966788703e0", from: "2016-03-23", to: "2026-03-23" },
];

function d1(sql: string): Record<string, unknown>[] {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed[0] : parsed)?.results ?? [];
}

const esc = (v: unknown) =>
  v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

const escId = (id: string) => id.replace(/'/g, "''");

console.log(`Fixing ${TARGETS.length} receipt(s)${WRITE ? " [WRITE]" : " [dry-run]"}\n`);

for (const t of TARGETS) {
  // Guardrail 1: not matched to any finalized reconciliation line (recon-sealed
  // gate). Unmatched AMEX → no lock.
  const matchRow = d1(
    `SELECT ar.status AS recon_status
       FROM amex_statement_lines AS asl
       JOIN amex_reconciliations AS ar
         ON ar.statement_month = asl.statement_month
      WHERE asl.matched_receipt_id = '${escId(t.id)}' AND ar.status = 'finalized'
      LIMIT 1;`,
  );
  if (matchRow.length > 0) {
    console.log(`✖ ${t.id}: matched to a finalized reconciliation — STOP (would be locked).`);
    continue;
  }

  // Current row (for the idempotent guard + the audit old_value_json).
  const rows = d1(
    `SELECT * FROM receipt_records WHERE id = '${escId(t.id)}' AND deleted_at IS NULL LIMIT 1;`,
  );
  if (rows.length === 0) {
    console.log(`✖ ${t.id}: not found (or deleted) — skip.`);
    continue;
  }
  const before = rows[0]!;
  if (before.transaction_date !== t.from) {
    console.log(
      `• ${t.id}: transaction_date is ${before.transaction_date} (expected ${t.from}) — already fixed or unexpected, skip.`,
    );
    continue;
  }

  const oldJson = JSON.stringify(before);
  const newJson = JSON.stringify({ transactionDate: t.to });
  const now = new Date().toISOString();
  const auditId = randomUUID();

  console.log(`• ${t.id}  (${before.merchant})`);
  console.log(`    transaction_date: ${t.from} -> ${t.to}`);

  if (WRITE) {
    // Guardrail 2: idempotent — only update if still on the anomalous date.
    d1(
      `UPDATE receipt_records
         SET transaction_date = '${t.to}', updated_at = '${now}'
       WHERE id = '${escId(t.id)}' AND transaction_date = '${t.from}';
       INSERT INTO receipt_audit_log
         (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
       VALUES
         ('${auditId}', ${esc(ACTOR)}, 'receipt.updated', 'receipt', '${escId(t.id)}',
          ${esc(oldJson)}, ${esc(newJson)}, '${now}');`,
    );
    console.log(`    [written + audited]`);
  }
}

console.log(
  `\nDone${WRITE ? "" : " (dry-run — re-run with --write to persist)"}.`,
);
