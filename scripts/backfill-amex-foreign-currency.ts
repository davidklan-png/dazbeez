#!/usr/bin/env -S npx tsx
// Backfill the migration-0026 foreign-currency columns on already-imported
// amex_statement_lines rows for OPEN statement months only, so this cycle's
// stuck Cloudflare/Anthropic USD receipts become matchable without a re-import.
//
// What it does: for every line in a non-finalized month whose memo is not null,
// re-run the single parser (parseForeignCurrencyMemo from
// lib/receipts/foreign-currency — the same one the import path uses) and write
// foreign_amount_minor / foreign_currency / memo_currency_parse_status.
//
// What it does NOT do:
//   * Touch finalized months (immutable per the existing guard; the
//     statement_month NOT IN (finalized) filter enforces this).
//   * Recover foreign_exchange_rate. The 円換算レート lives on the trailing
//     continuation row, which the CSV parser discards at import time and never
//     persists — so for already-imported rows the rate is gone. The rate is a
//     BONUS cross-check signal only (never used to match), so its absence here
//     leaves cleanly-parsed rows as status='parsed' (no cross-check possible),
//     exactly as on a fresh import whose continuation row failed to parse.
//     Fresh imports going forward DO capture the rate. (Reported below.)
//   * Run the rate cross-check (can't — no rate). Status is 'parsed' whenever
//     the primary 現地通貨額 regex succeeds.
//
// WHERE THIS RUNS: the Mac, with live Cloudflare bindings — it shells out to
// `wrangler d1 execute RECEIPTS_DB --remote`. It imports the PURE parser from
// lib/receipts/foreign-currency.ts (no D1 inside it).
//
// SAFETY:
//   * Dry-run by default. Pass --write to persist. Pass --month YYYY-MM to scope
//     to one open month (still must be non-finalized).
//   * Idempotent: parseForeignCurrencyMemo is a pure function of memo, and the
//     UPDATE only writes memo-derived columns. Re-running after --write produces
//     identical values (no audit row is written either way).
//
// USAGE:
//   npx tsx scripts/backfill-amex-foreign-currency.ts                  # dry-run summary (all open months)
//   npx tsx scripts/backfill-amex-foreign-currency.ts --write           # persist (all open months)
//   npx tsx scripts/backfill-amex-foreign-currency.ts --month 2026-07   # scope to one open month
//   npx tsx scripts/backfill-amex-foreign-currency.ts --month 2026-07 --write

import { execFileSync } from "node:child_process";
import { parseForeignCurrencyMemo } from "@/lib/receipts/foreign-currency";

const DB = "RECEIPTS_DB";
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const MONTH_FLAG = args.includes("--month")
  ? (args[args.indexOf("--month") + 1] ?? null)
  : null;

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
const intOrNullOr = (v: number | null) => (v == null ? "NULL" : String(v));

const monthFilter = MONTH_FLAG ? `AND statement_month = ${esc(MONTH_FLAG)}` : "";

// Open months only: exclude months with a finalized reconciliation.
const rows = d1(
  `SELECT id, statement_month, amount_minor, memo
   FROM amex_statement_lines
   WHERE memo IS NOT NULL
     AND statement_month NOT IN (
       SELECT statement_month FROM amex_reconciliations WHERE status = 'finalized'
     )
     ${monthFilter}
   ORDER BY statement_month ASC, transaction_date ASC;`,
);

// ── Classify each row via the single parser ────────────────────────────────
type Plan = {
  id: string;
  month: string;
  amountMinor: number;
  memo: string;
  status: "none" | "parsed" | "unparsed";
  foreignAmountMinor: number | null; // signed (inherits amount_minor sign)
  foreignCurrency: string | null;
};

const plans: Plan[] = [];
for (const r of rows) {
  const memo = String(r.memo);
  const amountMinor = Number(r.amount_minor);
  const parsed = parseForeignCurrencyMemo(memo);
  const plan: Plan = {
    id: String(r.id),
    month: String(r.statement_month),
    amountMinor,
    memo,
    status: parsed.status,
    foreignAmountMinor: null,
    foreignCurrency: null,
  };
  if (parsed.status === "parsed") {
    // Sign inheritance: memo is a magnitude only; a refund line (negative
    // amount_minor) gets a negative foreign amount too.
    plan.foreignAmountMinor = amountMinor < 0 ? -parsed.amountMinor : parsed.amountMinor;
    plan.foreignCurrency = parsed.currency;
  }
  plans.push(plan);
}

// ── Counts by (month, status) ──────────────────────────────────────────────
const byMonthStatus: Record<string, Record<string, number>> = {};
for (const p of plans) {
  const m = (byMonthStatus[p.month] ??= { none: 0, parsed: 0, unparsed: 0 });
  m[p.status] += 1;
}

const totals = { none: 0, parsed: 0, unparsed: 0 };
for (const p of plans) totals[p.status] += 1;

console.log(
  `\nBackfilling foreign-currency columns on ${rows.length} memo-bearing line(s) in open month(s)${
    MONTH_FLAG ? ` [scoped to ${MONTH_FLAG}]` : ""
  }${WRITE ? " [WRITE]" : " [dry-run]"}\n`,
);
for (const month of Object.keys(byMonthStatus).sort()) {
  const c = byMonthStatus[month]!;
  console.log(
    `  ${month}: ${c.none} none · ${c.parsed} parsed · ${c.unparsed} unparsed`,
  );
}
console.log(
  `\nTotals: ${totals.none} none · ${totals.parsed} parsed · ${totals.unparsed} unparsed\n`,
);

// ── Spot-check unparsed memos (report format surprises, don't work around them) ─
const unparsed = plans.filter((p) => p.status === "unparsed");
if (unparsed.length > 0) {
  console.log(`Unparsed memos (showing up to 10) — report these to the architect if the`);
  console.log(`marker format differs from 現地通貨額:<amt> <CCY>:\n`);
  for (const p of unparsed.slice(0, 10)) {
    console.log(`  [${p.month}] ${p.memo.slice(0, 80)}`);
  }
  if (unparsed.length > 10) console.log(`  …and ${unparsed.length - 10} more`);
  console.log("");
}

if (!WRITE) {
  if (totals.parsed + totals.unparsed > 0) {
    console.log("Dry run only. Re-run with --write to persist.");
  } else {
    console.log("Nothing to backfill — no memo carries a 現地通貨額 marker in the open month(s).");
  }
} else {
  // Batch the per-row UPDATEs to keep wrangler spawns bounded. Each statement
  // is independent and idempotent; ordering within a batch is irrelevant.
  const BATCH = 25;
  const toWrite = plans.filter((p) => p.status !== "none");
  for (let i = 0; i < toWrite.length; i += BATCH) {
    const chunk = toWrite.slice(i, i + BATCH);
    const sql = chunk
      .map(
        (p) =>
          `UPDATE amex_statement_lines
             SET foreign_amount_minor = ${intOrNullOr(p.foreignAmountMinor)},
                 foreign_currency = ${esc(p.foreignCurrency)},
                 memo_currency_parse_status = ${esc(p.status === "none" ? null : p.status)}
           WHERE id = ${esc(p.id)};`,
      )
      .join("\n");
    d1(sql);
  }
  console.log(
    `Wrote ${toWrite.length} row(s) (${totals.parsed} parsed, ${totals.unparsed} unparsed).`,
  );
  console.log(
    `Note: foreign_exchange_rate is NOT set by this backfill (the continuation-row rate is` +
      ` not persisted on already-imported rows). Cleanly-parsed rows are status='parsed'.`,
  );
}
