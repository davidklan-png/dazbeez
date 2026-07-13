#!/usr/bin/env -S npx tsx
// One-time policy migration (ADR 0008): reassign every DATED CASH/DIGITAL
// receipt's export_statement_month to the CALENDAR month of its
// transaction_date, replacing the ADR 0006 statement-cycle-window assignment.
//
// This is NOT the normal assignment path and is NOT a sticky violation — it is
// an explicit operator-directed rule change (window → calendar), audited as
// receipt.export_statement_month_policy_migrated with the old month, the new
// month, and reason "ADR 0008 policy migration". The capture / date-set hooks
// (assignMembershipForReceipt) are sticky and NULL-only by design; this script
// intentionally overwrites existing values because the policy itself changed.
//
// WHERE THIS RUNS: the Mac, with live Cloudflare bindings — it shells out to
// `wrangler d1 execute RECEIPTS_DB --remote`. It imports the PURE naturalMonth
// helper from lib/receipts/statement-window.ts (no D1 inside the pure
// functions). Run with tsx: `npx tsx scripts/migrate-membership-to-calendar-month.ts`.
//
// SAFETY:
//   * Dry-run by default. Pass --write to persist. Pass --id <id> for one receipt.
//   * Idempotent on result (calendar month is deterministic) and on audit: a row
//     whose current month already equals its calendar month is a no-op — no
//     UPDATE, no audit row. Re-running after --write changes nothing.
//   * CASH/DIGITAL only. AMEX (line-based membership) and UNKNOWN (scoped at
//     gate time, never stored) are never touched.
//   * Undated cash/digital receipts (transaction_date NULL) stay NULL
//     (unassignable) — they are excluded by the transaction_date IS NOT NULL
//     filter and are not in scope for a calendar-month rule.
//   * Roll-forward does NOT apply here: this is an explicit policy overwrite, and
//     at migration time no export month is sealed (verified 2026-07-13). If a
//     calendar month were sealed, the operator's directive ("reassign every
//     receipt to its calendar month") still wins — stickiness is a property of
//     the automatic hooks, not of this one-time policy action.
//
// USAGE:
//   npx tsx scripts/migrate-membership-to-calendar-month.ts            # dry-run summary
//   npx tsx scripts/migrate-membership-to-calendar-month.ts --write    # persist + audit
//   npx tsx scripts/migrate-membership-to-calendar-month.ts --id <id>  # single receipt

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { naturalMonth } from "@/lib/receipts/statement-window";

const DB = "RECEIPTS_DB";
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ONLY_ID = args.includes("--id") ? args[args.indexOf("--id") + 1] ?? null : null;
const REASON = "ADR 0008 policy migration";

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

const idFilter = ONLY_ID ? `AND id = ${esc(ONLY_ID)}` : "";
const candidates = d1(
  `SELECT id, payment_path, transaction_date, export_statement_month, merchant
   FROM receipt_records
   WHERE deleted_at IS NULL
     AND payment_path IN ('CASH', 'DIGITAL')
     AND transaction_date IS NOT NULL
     ${idFilter}
   ORDER BY transaction_date ASC;`,
);

// ── Before/after distribution (always printed) ──────────────────────────────
const beforeByMonth: Record<string, number> = {};
const afterByMonth: Record<string, number> = {};
for (const r of candidates) {
  const oldM = (r.export_statement_month as string | null) ?? "NULL";
  const newM = naturalMonth(r.transaction_date as string) ?? "NULL";
  beforeByMonth[oldM] = (beforeByMonth[oldM] ?? 0) + 1;
  afterByMonth[newM] = (afterByMonth[newM] ?? 0) + 1;
}
console.log(
  `\nMigrating ${candidates.length} dated CASH/DIGITAL receipt(s) to calendar month${
    WRITE ? " [WRITE]" : " [dry-run]"
  }\n`,
);
console.log("Before (current export_statement_month):");
for (const m of Object.keys(beforeByMonth).sort()) console.log(`  ${m}: ${beforeByMonth[m]}`);
console.log("After (calendar month of transaction_date):");
for (const m of Object.keys(afterByMonth).sort()) console.log(`  ${m}: ${afterByMonth[m]}`);

// ── Reassign each candidate (skip no-ops) ───────────────────────────────────
let changed = 0;
let noop = 0;

for (const r of candidates) {
  const id = String(r.id);
  const date = String(r.transaction_date);
  const oldMonth = (r.export_statement_month as string | null) ?? null;
  const newMonth = naturalMonth(date);

  if (newMonth === null) {
    // Defensive: the filter guarantees a non-null date, but a malformed one has
    // no calendar month. Skip it (stays NULL) and flag.
    console.log(`• ${id}  ${date}  ${String(r.merchant)}  → SKIP (malformed date)`);
    continue;
  }

  if (newMonth === oldMonth) {
    noop++;
    continue;
  }

  changed++;
  const oldLabel = oldMonth ?? "NULL";
  console.log(`• ${id}  ${date}  ${String(r.merchant)}  → ${newMonth}  (was ${oldLabel})`);

  if (WRITE) {
    const now = new Date().toISOString();
    const auditId = randomUUID();
    const newValue = JSON.stringify({
      export_statement_month: newMonth,
      reason: REASON,
    });
    // UPDATE (overwrite — this is the policy migration, not the sticky NULL-only
    // path) + audit INSERT in one command so they land together.
    d1(
      `UPDATE receipt_records
         SET export_statement_month = ${esc(newMonth)}, updated_at = ${esc(now)}
       WHERE id = ${esc(id)};` +
        `INSERT INTO receipt_audit_log
           (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
         VALUES (
           ${esc(auditId)}, ${esc("system:adr0008-migration")}, ${esc("receipt.export_statement_month_policy_migrated")},
           ${esc("receipt")}, ${esc(id)},
           ${esc(JSON.stringify({ export_statement_month: oldMonth }))}, ${esc(newValue)}, ${esc(now)}
         );`,
    );
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nSummary (${WRITE ? "persisted" : "dry-run"}):`);
console.log(`  candidates (dated cash/digital): ${candidates.length}`);
console.log(`  changed:                        ${changed}`);
console.log(`  no-op (already calendar month): ${noop}`);
if (WRITE) {
  console.log(`  audit rows written:             ${changed} (action receipt.export_statement_month_policy_migrated)`);
} else if (changed > 0) {
  console.log("\nDry run only. Re-run with --write to persist + audit.");
}
if (changed === 0 && noop === candidates.length) {
  console.log("\nNothing to change — every dated cash/digital receipt is already on its calendar month.");
}
