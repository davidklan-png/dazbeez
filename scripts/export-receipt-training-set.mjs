#!/usr/bin/env node
// Export reconciled/reviewed receipts into a labeled training set for a bespoke
// extraction model.
//
// WHERE THIS RUNS: the Mac, with live Cloudflare bindings (per AGENTS.md the Mac
// owns wrangler auth + D1/R2 access). It shells out to `wrangler`; it does NOT
// run in a cloud sandbox.
//
// WHAT IT DOES: every receipt a human has verified is a gold-labeled example.
// The reviewer-confirmed columns on receipt_records are the TARGET; the old
// pipeline's prediction (extraction_json) is kept alongside as a BASELINE so you
// can see where a model would actually learn something. Receipts reconciled to
// an AMEX statement line (match_status='confirmed') are double-verified.
//
// USAGE:
//   node scripts/export-receipt-training-set.mjs --dry-run        # stats only, no downloads
//   node scripts/export-receipt-training-set.mjs                  # writes dataset + images
//   node scripts/export-receipt-training-set.mjs --limit 25       # small sample
//   node scripts/export-receipt-training-set.mjs --out ./my-dir   # custom output dir
//
// OUTPUT (default ./receipt-training-set/):
//   dataset.jsonl   one example per line: { id, image, target, baseline_extraction, reconciled }
//   images/         original receipt images pulled from R2
//   summary.json    counts by expense_type / currency / reconciled / baseline-disagreement

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────
const DB_BINDING = "RECEIPTS_DB";
const BUCKET = "dazbeez-receipts";
// Statuses that mean "a human has verified this receipt". 'captured' and
// 'needs_review' are excluded — they are not yet trustworthy labels.
const VERIFIED_STATUSES = ["reviewed", "reconciled", "exported", "archived"];

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const DRY_RUN = has("--dry-run");
const LIMIT = Number(val("--limit", "0")) || 0;
const OUT_DIR = val("--out", "./receipt-training-set");

// ── Helpers ─────────────────────────────────────────────────────────────────
function wrangler(argv) {
  return execFileSync("npx", ["wrangler", ...argv], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function d1Query(sql) {
  const raw = wrangler([
    "d1",
    "execute",
    DB_BINDING,
    "--remote",
    "--json",
    "--command",
    sql,
  ]);
  const parsed = JSON.parse(raw);
  // wrangler returns [{ results: [...], success, meta }]
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return block?.results ?? [];
}

function safeParse(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function tally(rows, key) {
  return rows.reduce((acc, r) => {
    const k = r[key] ?? "(null)";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

// ── Pull verified receipts (+ whether reconciled to an AMEX line) ───────────
const statusList = VERIFIED_STATUSES.map((s) => `'${s}'`).join(",");
const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : "";
const sql = `
  SELECT
    r.id, r.status,
    r.transaction_date, r.merchant, r.amount_minor, r.currency,
    r.tax_amount_minor, r.expense_type, r.business_purpose,
    r.original_r2_key, r.original_content_type, r.extraction_json,
    CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END AS reconciled
  FROM receipt_records r
  LEFT JOIN amex_statement_lines a
    ON a.matched_receipt_id = r.id AND a.match_status = 'confirmed'
  WHERE r.status IN (${statusList})
    AND r.legacy = 0
  ${limitClause};
`;

console.log(`Querying ${DB_BINDING} for verified receipts (${VERIFIED_STATUSES.join(", ")})...`);
const rows = d1Query(sql);
console.log(`Found ${rows.length} verified receipts.\n`);

// ── Stats ───────────────────────────────────────────────────────────────────
const reconciledCount = rows.filter((r) => r.reconciled === 1).length;
const withImage = rows.filter((r) => r.original_r2_key).length;

// How often did the old pipeline disagree with the human-confirmed value?
// (a proxy for "examples a model would actually learn from")
let disagreements = 0;
for (const r of rows) {
  const base = safeParse(r.extraction_json);
  if (!base) continue;
  const mismatch =
    (base.merchant ?? null) !== (r.merchant ?? null) ||
    (base.amountMinor ?? null) !== (r.amount_minor ?? null) ||
    (base.transactionDate ?? null) !== (r.transaction_date ?? null) ||
    (base.expenseType ?? null) !== (r.expense_type ?? null);
  if (mismatch) disagreements += 1;
}

const summary = {
  generated_at: new Date().toISOString(),
  total_verified: rows.length,
  with_image: withImage,
  reconciled_to_amex: reconciledCount,
  baseline_disagreements: disagreements,
  by_expense_type: tally(rows, "expense_type"),
  by_currency: tally(rows, "currency"),
  by_status: tally(rows, "status"),
};

console.log("── Training-set summary ──────────────────────────────");
console.log(`  Verified (labeled) receipts : ${summary.total_verified}`);
console.log(`  With downloadable image     : ${summary.with_image}`);
console.log(`  Double-verified (AMEX recon): ${summary.reconciled_to_amex}`);
console.log(`  Old pipeline disagreed      : ${summary.baseline_disagreements}  <- highest-value examples`);
console.log(`  By expense_type             : ${JSON.stringify(summary.by_expense_type)}`);
console.log(`  By currency                 : ${JSON.stringify(summary.by_currency)}`);
console.log("──────────────────────────────────────────────────────\n");

if (DRY_RUN) {
  console.log("--dry-run: no files written. Re-run without --dry-run to export images + dataset.jsonl.");
  process.exit(0);
}

// ── Write dataset + pull images ─────────────────────────────────────────────
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(join(OUT_DIR, "images"), { recursive: true });
const jsonlPath = join(OUT_DIR, "dataset.jsonl");
writeFileSync(jsonlPath, "");

let imagesOk = 0;
let imagesFailed = 0;

for (const [i, r] of rows.entries()) {
  const ext = (r.original_content_type || "").includes("png") ? "png" : "jpg";
  const imageRel = `images/${r.id}.${ext}`;
  let imageField = null;

  if (r.original_r2_key) {
    try {
      // Newer wrangler requires --file; older versions stream to stdout.
      wrangler([
        "r2",
        "object",
        "get",
        `${BUCKET}/${r.original_r2_key}`,
        "--remote",
        "--file",
        join(OUT_DIR, imageRel),
      ]);
      imageField = imageRel;
      imagesOk += 1;
    } catch (e) {
      imagesFailed += 1;
      console.warn(`  ! image fetch failed for ${r.id}: ${String(e.message).split("\n")[0]}`);
    }
  }

  const example = {
    id: r.id,
    image: imageField,
    reconciled: r.reconciled === 1,
    target: {
      merchant: r.merchant,
      transactionDate: r.transaction_date,
      amountMinor: r.amount_minor,
      currency: r.currency,
      taxAmountMinor: r.tax_amount_minor,
      expenseType: r.expense_type,
      businessPurpose: r.business_purpose,
    },
    baseline_extraction: safeParse(r.extraction_json),
  };
  appendFileSync(jsonlPath, JSON.stringify(example) + "\n");

  if ((i + 1) % 25 === 0) console.log(`  ...${i + 1}/${rows.length}`);
}

summary.images_downloaded = imagesOk;
summary.images_failed = imagesFailed;
writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));

console.log(`\nDone. Wrote ${rows.length} examples to ${jsonlPath}`);
console.log(`Images: ${imagesOk} ok, ${imagesFailed} failed. Summary: ${join(OUT_DIR, "summary.json")}`);
