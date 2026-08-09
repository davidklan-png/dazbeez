#!/usr/bin/env -S npx tsx
// Backfill the missing is_original receipt_files manifest row for receipts that
// have an original_r2_key but ZERO receipt_files rows. Root cause: promoteIntake's
// attachment branch (ADR 0011) wrote the receipt but never its manifest row — the
// same divergence as the enqueue bug, fixed in lib/receipts/email-intake.ts
// (Task A). This heals the stranded email_attachment receipts (and any other
// zero-file receipt) so the proofs gate (validateMonthReadyForExportCore /
// countReceiptFilesByObjectIds) no longer flags them missing_receipt and blocks
// month finalize. Backlog #5 (receipt_files write integrity) recurring in a path
// that postdates it.
//
// WHERE THIS RUNS: the Mac, with live Cloudflare bindings (shells out to
// wrangler). Run with tsx: `npx tsx scripts/backfill-missing-manifest.ts`.
//
// SAFETY: scoped by INVARIANT (zero file rows AND original_r2_key IS NOT NULL),
// NOT a hardcoded id list. Verifies the R2 object exists before inserting — a
// manifest row pointing at nothing is worse than no row. Dry-run by default;
// pass --write to persist.
//
// USAGE:
//   npx tsx scripts/backfill-missing-manifest.ts            # dry-run: candidate set + planned inserts
//   npx tsx scripts/backfill-missing-manifest.ts --write    # insert the manifest rows + audit

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const DB = "RECEIPTS_DB";
const BUCKET = "dazbeez-receipts";
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const ACTOR = "backfill-missing-manifest.ts";

function d1(sql: string): Record<string, unknown>[] {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed[0] : parsed)?.results ?? [];
}

const esc = (v: string | null | undefined) =>
  v == null || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

// Candidate set: zero receipt_files rows AND a non-null original_r2_key.
const rows = d1(`
  SELECT rr.id, rr.source_type, rr.original_r2_key, rr.original_sha256,
         rr.original_content_type, rr.original_size_bytes, rr.original_filename
  FROM receipt_records rr
  WHERE rr.deleted_at IS NULL
    AND rr.original_r2_key IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM receipt_files rf
      WHERE rf.object_type = 'receipt' AND rf.object_id = rr.id
    )
  ORDER BY rr.captured_at DESC;
`);

console.log(
  `Backfill candidates: ${rows.length} receipt(s)${WRITE ? " [WRITE]" : " [dry-run]"}\n`,
);

// Report the candidate set by source_type (sanity gate — expected only
// email_attachment; anything else is a different capture path with the same
// defect and must be reported before writing).
const bySource = new Map<string, number>();
for (const r of rows) {
  const st = String(r.source_type ?? "null");
  bySource.set(st, (bySource.get(st) ?? 0) + 1);
}
console.log("By source_type:");
for (const [st, n] of [...bySource.entries()].sort()) console.log(`  ${st}: ${n}`);
console.log("");

if (rows.length === 0) {
  console.log("Nothing to backfill.");
  process.exit(0);
}

// wrangler r2 object has no `head` subcommand; `get --pipe` is the existence
// probe (exit 0 = exists, throws on missing). Output is discarded.
function r2ObjectExists(key: string): boolean {
  try {
    execFileSync(
      "npx",
      ["wrangler", "r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--pipe"],
      { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
    );
    return true;
  } catch {
    return false;
  }
}

let inserted = 0;
let skipped = 0;
for (const r of rows) {
  const id = String(r.id);
  const key = String(r.original_r2_key);
  const filename =
    (r.original_filename as string | null) ?? key.split("/").pop() ?? "attachment";
  const contentType =
    (r.original_content_type as string | null) ?? "application/octet-stream";
  const size = (r.original_size_bytes as number | null) ?? 0;
  const sha = (r.original_sha256 as string | null) ?? "";

  if (!r2ObjectExists(key)) {
    skipped++;
    console.log(`• ${id} [${r.source_type}] SKIP — R2 object missing at ${key}`);
    continue;
  }

  console.log(
    `• ${id} [${r.source_type}] ${filename} · ${contentType} · ${size}B` +
      (sha ? ` · sha ${sha.slice(0, 8)}` : ""),
  );

  if (WRITE) {
    const now = new Date().toISOString();
    const fileId = randomUUID();
    const auditId = randomUUID();
    const auditJson = JSON.stringify({
      reason:
        "backfilled is_original receipt_files manifest row (missing from promoteIntake attachment branch)",
      r2_key: key,
      filename,
      content_type: contentType,
      size_bytes: size,
    });
    d1(
      `INSERT INTO receipt_files
         (id, object_type, object_id, role, r2_bucket, r2_key, original_filename,
          content_type, file_size_bytes, sha256_hash, uploaded_by, uploaded_at,
          is_original, created_at, updated_at)
       VALUES (${esc(fileId)}, 'receipt', ${esc(id)}, 'original', 'receipts',
               ${esc(key)}, ${esc(filename)}, ${esc(contentType)}, ${size},
               ${esc(sha)}, ${esc(ACTOR)}, ${esc(now)}, 1, ${esc(now)}, ${esc(now)});
       INSERT INTO receipt_audit_log
         (id, actor, action, object_type, object_id, new_value_json, created_at)
       VALUES (${esc(auditId)}, ${esc(ACTOR)}, 'receipt.updated', 'receipt',
               ${esc(id)}, ${esc(auditJson)}, ${esc(now)});`,
    );
    inserted++;
  }
}

const plan = rows.length - skipped;
console.log(
  `\n${WRITE ? `${inserted} manifest row(s) inserted; ${skipped} skipped.` : `${plan} would insert; ${skipped} would skip (R2 missing).`}`,
);
if (!WRITE && plan > 0) console.log("Re-run with --write to persist.");
