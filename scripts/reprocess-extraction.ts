#!/usr/bin/env -S npx tsx
// Reprocess receipts with the current extraction parser, using the OCR text
// already stored in each receipt's extraction_json — so it costs nothing
// (no Google Vision re-call) and works the moment the parser code is updated.
//
// WHERE THIS RUNS: the Mac, with live Cloudflare bindings (it shells out to
// `wrangler`). It imports the real parser from lib/receipts/extraction.ts, so
// run it with tsx: `npx tsx scripts/reprocess-extraction.ts`.
//
// SAFETY: only receipts that have NOT been reviewed yet (status captured /
// needs_review) are eligible — reviewed/reconciled/exported/archived rows are
// never touched. Dry-run by default; pass --write to persist.
//
// USAGE:
//   npx tsx scripts/reprocess-extraction.ts            # dry-run: before/after table
//   npx tsx scripts/reprocess-extraction.ts --write    # persist corrected fields + audit
//   npx tsx scripts/reprocess-extraction.ts --id <id>  # single receipt

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseReceiptOcrText } from "@/lib/receipts/extraction";

const DB = "RECEIPTS_DB";
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ONLY_ID = args.includes("--id") ? args[args.indexOf("--id") + 1] : null;
const ELIGIBLE = ["captured", "needs_review"];

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

const where = ONLY_ID
  ? `id = '${ONLY_ID.replace(/'/g, "''")}'`
  : `status IN (${ELIGIBLE.map((s) => `'${s}'`).join(",")})`;

const rows = d1(`
  SELECT id, status, merchant, tax_amount_minor, tax_rate, invoice_registration_number, extraction_json
  FROM receipt_records
  WHERE extraction_json IS NOT NULL AND ${where}
  ORDER BY captured_at DESC;
`);

console.log(`Reprocessing ${rows.length} receipt(s)${WRITE ? " [WRITE]" : " [dry-run]"}\n`);

let changed = 0;
for (const r of rows) {
  const id = String(r.id);
  if (!ELIGIBLE.includes(String(r.status))) continue; // never touch reviewed+

  let rawText = "";
  try {
    rawText = JSON.parse(String(r.extraction_json)).rawText ?? "";
  } catch {
    continue;
  }
  if (!rawText) continue;

  const next = parseReceiptOcrText(rawText);
  const diffs: string[] = [];
  if (next.merchant && next.merchant !== r.merchant)
    diffs.push(`merchant: ${JSON.stringify(r.merchant)} -> ${JSON.stringify(next.merchant)}`);
  if (next.taxAmountMinor != null && next.taxAmountMinor !== r.tax_amount_minor)
    diffs.push(`tax: ${r.tax_amount_minor} -> ${next.taxAmountMinor}`);
  if (next.invoiceRegistrationNumber && next.invoiceRegistrationNumber !== r.invoice_registration_number)
    diffs.push(`invoiceNo: ${r.invoice_registration_number ?? "∅"} -> ${next.invoiceRegistrationNumber}`);

  if (diffs.length === 0) continue;
  changed++;
  console.log(`• ${id}\n    ${diffs.join("\n    ")}`);

  if (WRITE) {
    const sets = [
      next.merchant ? `merchant = ${esc(next.merchant)}` : null,
      next.taxAmountMinor != null ? `tax_amount_minor = ${next.taxAmountMinor}` : null,
      next.taxRate ? `tax_rate = ${esc(next.taxRate)}` : null,
      next.invoiceRegistrationNumber ? `invoice_registration_number = ${esc(next.invoiceRegistrationNumber)}` : null,
      `updated_at = '${new Date().toISOString()}'`,
    ].filter(Boolean);
    const audit = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      changes: diffs,
    };
    d1(
      `UPDATE receipt_records SET ${sets.join(", ")} WHERE id = '${id}' AND status IN (${ELIGIBLE.map((s) => `'${s}'`).join(",")});` +
        `INSERT INTO receipt_audit_log (id, actor, action, object_type, object_id, new_value_json, created_at) ` +
        `VALUES ('${audit.id}', 'reprocess-extraction.ts', 'receipt.updated', 'receipt', '${id}', ${esc(JSON.stringify(audit))}, '${audit.created_at}');`,
    );
  }
}

console.log(`\n${changed} receipt(s) ${WRITE ? "updated" : "would change"}.`);
if (!WRITE && changed > 0) console.log("Re-run with --write to persist.");
