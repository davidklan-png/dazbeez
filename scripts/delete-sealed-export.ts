#!/usr/bin/env -S npx tsx
// delete-sealed-export.ts — the ONLY sanctioned way to delete a sealed export.
//
// Sealing locks edits; deletion is the one hole in that guarantee, and until now
// it had no code-review surface (2026-06 revs 1 & 2 were removed out-of-band on
// 2026-07-22, recorded with non-union audit actions; no committed code deletes
// receipt_exports). This script is that surface. The refusal logic lives in the
// pure, unit-tested lib/receipts/export-deletion.ts → planExportDeletion; this
// file is the thin I/O wrapper (D1 + R2 via wrangler).
//
// Usage:
//   npx tsx scripts/delete-sealed-export.ts \
//     --export-id <uuid> --month <YYYY-MM> --reason "<legal-hold exception>"
//   # dry-run by default — prints the R2 objects + D1 deletes it WOULD do.
//   # add --write --confirm-delete <same-id> to actually delete.
//
// Refuses by default. Requires an explicit export id AND month (exact — no
// wildcards, no "all drafts"), an explicit legal-hold exception string, and
// refuses outright if any delivery row is state 'sent' (delivered). Never run
// against a delivered month.
//
// NEVER run this against real data without operator authorization + a dry-run
// read first. The planner is unit-tested; this wrapper is not.

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import {
  buildExportDeletionStatements,
  planExportDeletion,
} from "@/lib/receipts/export-deletion";

const DB = "RECEIPTS_DB";
const BUCKET = "dazbeez-receipts-archive";
const ACTOR = "delete-sealed-export.ts";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const exportId = arg("export-id")?.trim();
const month = arg("month")?.trim();
const reason = arg("reason");
const WRITE = args.includes("--write");
const confirmDelete = arg("confirm-delete")?.trim();

if (!exportId || !month || !reason) {
  console.error(
    "Usage: npx tsx scripts/delete-sealed-export.ts --export-id <uuid> --month <YYYY-MM> --reason \"<legal-hold exception>\" [--write --confirm-delete <same-id>]",
  );
  console.error("Dry-run by default. All three of --export-id, --month, --reason are required.");
  process.exit(1);
}

const esc = (v: string | number | null | undefined) =>
  v == null || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;

function d1(sql: string): Record<string, unknown>[] {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed[0] : parsed)?.results ?? [];
}

function r2Delete(key: string): boolean {
  // No `wrangler r2 object head` exists; delete directly and tolerate absence
  // (recon CSVs / proofs are conditional — some keys never had an object).
  try {
    execFileSync(
      "npx",
      ["wrangler", "r2", "object", "delete", `${BUCKET}/${key}`, "--remote"],
      { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Gather facts, plan ──────────────────────────────────────────────────────
const exportRow = (d1(`SELECT * FROM receipt_exports WHERE id = ${esc(exportId)}`)[0] ?? null) as
  | (Record<string, unknown> & { id?: string; export_month?: string })
  | null;
const deliveries = d1(
  `SELECT state FROM export_deliveries WHERE export_id = ${esc(exportId)}`,
) as { state: string }[];

const result = planExportDeletion(
  { exportId, month, legalHoldException: reason },
  {
    exportRow: exportRow as never,
    deliveries,
    nowEpochSeconds: Math.floor(Date.now() / 1000),
  },
);

if (!result.ok) {
  console.error(`REFUSED: ${result.reason}`);
  process.exit(1);
}

const { plan } = result;
console.log(`Export ${exportId} (${month}) — deletion plan:`);
console.log(`  R2 objects to remove (${plan.r2Objects.length}):`);
for (const key of plan.r2Objects) console.log(`    ${BUCKET}/${key}`);
console.log(`  D1: DELETE FROM export_deliveries WHERE export_id = ${exportId};`);
console.log(`  D1: DELETE FROM receipt_exports WHERE id = ${exportId};  -- receipt_export_items cascade (0017 FK)`);
console.log(`  audit: export.deleted (retention_legalhold_exception recorded verbatim)`);

if (!WRITE) {
  console.log("\n[dry-run] no changes made. Re-run with --write --confirm-delete <export-id> to execute.");
  process.exit(0);
}

if (confirmDelete !== exportId) {
  console.error(
    `\nREFUSED: --write given but --confirm-delete must equal --export-id (${exportId}) to confirm.`,
  );
  process.exit(1);
}

// ─── Execute (B8): D1 transaction FIRST, R2 only after confirmed deletion ───
// The deletion statements come from the shared, tested builder
// (lib/receipts/export-deletion.ts buildExportDeletionStatements): the typed
// export.deleted marker is written INSIDE the transaction, gated on the
// planned identity and the absence of a live build claim — so a claim
// acquired after planning aborts the whole transaction (the 0042 guards
// refuse the sealed rows without the marker) and nothing is deleted. R2
// objects are removed only after the transaction reports the export row
// deleted; any uncertain outcome retains them.
console.log("\n[WRITE] executing deletion transaction...");
const plannedStatus = String((exportRow as Record<string, unknown>).status ?? "");
const stmts = buildExportDeletionStatements({
  exportId,
  month,
  plannedStatus,
  actor: ACTOR,
  nowIso: new Date().toISOString(),
  auditId: globalThis.crypto.randomUUID(),
  auditValueJson: plan.audit.newValueJson,
});
const sqlText = stmts
  .map((st) =>
    st.args.reduce<string>(
      (sql, arg) => sql.replace("?", esc(arg as string | number | null)),
      st.sql,
    ),
  )
  .join(";\n");
const tmpFile = `/tmp/delete-sealed-export-${exportId}.sql`;
writeFileSync(tmpFile, sqlText + ";\n");
let markerWritten = false;
let exportRowsDeleted = 0;
try {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--file", tmpFile],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  const results = (Array.isArray(parsed) ? parsed[0] : parsed)?.results ?? [];
  // wrangler --json reports one entry per statement; the marker is first and
  // the export DELETE last. A guard abort surfaces as a nonzero exit (caught
  // below) — nothing is deleted.
  markerWritten = (results[0]?.meta?.changes ?? 0) === 1;
  exportRowsDeleted = results[results.length - 1]?.meta?.changes ?? 0;
} catch (err) {
  console.error(`  [d1] REFUSED/FAILED: the deletion transaction did not commit (guard refusal or execution error). NOTHING was deleted and NO R2 object was touched.`);
  console.error(`  detail: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(2);
} finally {
  try { rmSync(tmpFile, { force: true }); } catch { /* best effort */ }
}
if (!markerWritten || exportRowsDeleted !== 1) {
  console.error(
    `  [d1] REFUSED: transactional identity/claim check did not confirm the planned deletion (marker=${markerWritten}, exportRowsDeleted=${exportRowsDeleted}). Rows are unchanged and all R2 objects are RETAINED — re-run the dry-run to re-plan.`,
  );
  process.exit(2);
}
console.log("  [d1] deleted the export row, its deliveries, and its item set in one transaction (export.deleted audited)");

let removed = 0;
for (const key of plan.r2Objects) {
  if (r2Delete(key)) {
    removed++;
    console.log(`  [r2] deleted ${BUCKET}/${key}`);
  } else {
    console.log(`  [r2] absent (tolerated) ${BUCKET}/${key}`);
  }
}
console.log(`  [audit] export.deleted recorded transactionally (removed ${removed} R2 object(s))`);
console.log(`\n[WRITE] done. R2 removed: ${removed}.`);
