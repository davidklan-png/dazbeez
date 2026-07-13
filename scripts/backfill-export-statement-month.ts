#!/usr/bin/env -S npx tsx
// Backfill receipt_records.export_statement_month for non-AMEX receipts
// (ADR 0006, PR #1). Computes each CASH/DIGITAL receipt's statement-cycle
// membership from the chained windows window(M) = (close(M-1), close(M)],
// where close(M) = MAX(transaction_date) over statement M's AMEX lines, and
// writes it to the new column with an audit row per assignment.
//
// WHERE THIS RUNS: the Mac, with live Cloudflare bindings — it shells out to
// `wrangler d1 execute RECEIPTS_DB --remote`. It imports the PURE assignment
// module from lib/receipts/statement-window.ts (no D1 inside the pure
// functions). Run with tsx: `npx tsx scripts/backfill-export-statement-month.ts`.
//
// WHY NOT getReceiptsDb()/createAuditEntry(): those rely on
// getCloudflareContext(), which only exists inside a Worker request. A
// standalone tsx script has no request context, so — like
// scripts/reprocess-extraction.ts — we drive D1 through the wrangler CLI and
// write audit rows via raw INSERT.
//
// SAFETY:
//   * Idempotent. Selects ONLY `WHERE export_statement_month IS NULL`, so an
//     already-assigned receipt is never re-derived (the ADR §D3 freeze rule).
//     Re-running after --write assigns nothing new.
//   * CASH/DIGITAL only. AMEX (line-based membership) and UNKNOWN (scoped at
//     gate time, never stored) are never touched.
//   * Receipts dated beyond the newest imported statement's close stay NULL
//     ("awaiting statement") — no UPDATE, no audit row. They are counted in
//     the summary.
//   * Roll-forward: a receipt whose natural month is sealed (finalized
//     reconciliation) rolls to the next open statement month, audited as
//     receipt.export_statement_month_rolled_forward.
//   * Dry-run by default. Pass --write to persist. Pass --id <id> for one receipt.
//
// USAGE:
//   npx tsx scripts/backfill-export-statement-month.ts            # dry-run summary
//   npx tsx scripts/backfill-export-statement-month.ts --write    # persist + audit
//   npx tsx scripts/backfill-export-statement-month.ts --id <id>  # single receipt

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  assignReceiptMembership,
  computeStatementWindows,
  type StatementClose,
} from "@/lib/receipts/statement-window";

const DB = "RECEIPTS_DB";
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ONLY_ID = args.includes("--id") ? args[args.indexOf("--id") + 1] ?? null : null;

function d1(sql: string): Record<string, unknown>[] {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed[0] : parsed)?.results ?? [];
}

const esc = (v: string | null) => (v == null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

// ── 1. Load the inputs the pure module needs ─────────────────────────────────
const closeRows = d1(
  `SELECT statement_month, MAX(transaction_date) AS close
   FROM amex_statement_lines
   WHERE transaction_date IS NOT NULL
   GROUP BY statement_month
   ORDER BY statement_month ASC;`,
);
const closes: StatementClose[] = closeRows.map((r) => ({
  statementMonth: String(r.statement_month),
  close: String(r.close),
}));

const sealedRows = d1(
  `SELECT statement_month FROM amex_reconciliations WHERE status = 'finalized';`,
);
const sealedMonths = new Set(sealedRows.map((r) => String(r.statement_month)));

const windows = computeStatementWindows(closes);

const idFilter = ONLY_ID ? `AND id = ${esc(ONLY_ID)}` : "";
const candidates = d1(
  `SELECT id, payment_path, transaction_date, merchant
   FROM receipt_records
   WHERE export_statement_month IS NULL
     AND payment_path IN ('CASH', 'DIGITAL')
     AND deleted_at IS NULL
     AND transaction_date IS NOT NULL
     ${idFilter}
   ORDER BY transaction_date ASC;`,
);

// ── 2. Window table (always printed — the empirical close-anchor view) ───────
console.log(
  `\nStatement-cycle windows (close(M) = MAX(transaction_date) over statement M's lines):`,
);
console.log(
  `  sealed months: ${sealedMonths.size ? [...sealedMonths].join(", ") : "(none)"}\n`,
);
for (const w of windows) {
  const start = w.startExclusive ?? "open";
  const sealed = sealedMonths.has(w.statementMonth) ? "  [SEALED]" : "";
  console.log(
    `  ${w.statementMonth}: (${start}, ${w.endInclusive}]${sealed}`,
  );
}

console.log(
  `\nBackfilling ${candidates.length} unassigned CASH/DIGITAL receipt(s)${
    WRITE ? " [WRITE]" : " [dry-run]"
  }\n`,
);

// ── 3. Assign each candidate ────────────────────────────────────────────────
const byReason: Record<string, number> = {
  natural: 0,
  "roll-forward": 0,
  awaiting: 0,
  "awaiting-rolled": 0,
};
const byMonth: Record<string, number> = {};
let assigned = 0;

for (const r of candidates) {
  const id = String(r.id);
  const date = String(r.transaction_date);
  const result = assignReceiptMembership(date, windows, sealedMonths, {
    rollForward: true,
  });
  byReason[result.reason] = (byReason[result.reason] ?? 0) + 1;

  if (result.month === null) {
    // Awaiting (or awaiting-rolled) — stays NULL. No UPDATE, no audit.
    const note = result.rolledFrom ? ` (would have rolled from ${result.rolledFrom})` : "";
    console.log(`• ${id}  ${date}  ${String(r.merchant)}  → AWAITING${note}`);
    continue;
  }

  assigned++;
  byMonth[result.month] = (byMonth[result.month] ?? 0) + 1;
  const rolledNote = result.rolledFrom ? `  [rolled from ${result.rolledFrom}]` : "";
  console.log(`• ${id}  ${date}  ${String(r.merchant)}  → ${result.month}${rolledNote}`);

  if (WRITE) {
    const now = new Date().toISOString();
    const auditId = randomUUID();
    const action =
      result.reason === "roll-forward"
        ? "receipt.export_statement_month_rolled_forward"
        : "receipt.export_statement_month_assigned";
    const newValue = JSON.stringify({
      export_statement_month: result.month,
      reason: result.reason,
      rolledFrom: result.rolledFrom ?? null,
    });
    // UPDATE + audit INSERT in one command so they land together (mirrors
    // scripts/reprocess-extraction.ts). The NULL-only WHERE also guards the
    // UPDATE against a race that assigned the row between SELECT and UPDATE.
    d1(
      `UPDATE receipt_records
         SET export_statement_month = ${esc(result.month)}, updated_at = ${esc(now)}
       WHERE id = ${esc(id)} AND export_statement_month IS NULL;` +
        `INSERT INTO receipt_audit_log
           (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
         VALUES (
           ${esc(auditId)}, ${esc("system:backfill")}, ${esc(action)},
           ${esc("receipt")}, ${esc(id)}, NULL, ${esc(newValue)}, ${esc(now)}
         );`,
    );
  }
}

// ── 4. Summary ──────────────────────────────────────────────────────────────
console.log(`\nSummary (${WRITE ? "persisted" : "dry-run"}):`);
console.log(`  candidates processed:  ${candidates.length}`);
console.log(`  assigned:              ${assigned}`);
console.log(`  left awaiting:         ${byReason.awaiting + (byReason["awaiting-rolled"] ?? 0)}`);
console.log(`    of which rolled-from (natural sealed, no newer open month): ${byReason["awaiting-rolled"] ?? 0}`);
console.log(`  by reason:`);
for (const [reason, n] of Object.entries(byReason)) {
  console.log(`    ${reason}: ${n}`);
}
console.log(`  assigned by month:`);
const months = Object.keys(byMonth).sort();
for (const m of months) {
  console.log(`    ${m}: ${byMonth[m]}`);
}
if (!WRITE && assigned > 0) {
  console.log("\nDry run only. Re-run with --write to persist.");
}
if (months.length === 0 && byReason.awaiting === 0 && (byReason["awaiting-rolled"] ?? 0) === 0) {
  console.log("\nNothing to do — no unassigned CASH/DIGITAL receipts.");
}
