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

// ─── Execute (B8/F2-F5): D1 transaction FIRST, R2 only after CONFIRMED
// deletion. The statements come from the shared, tested builder
// (buildExportDeletionStatements): the export.deleted marker + in-transaction
// admission assertion (identity, claim-free, delivery-refusal-free, and the
// planned published build/key identity rechecked at write time), then the
// deliveries delete and the parent delete whose FK cascade removes the items.
//
// TRANSPORT NOTE (F4): wrangler's `d1 execute --json --file` returns a
// SINGLE AGGREGATE result (human-readable stats row + aggregate meta), not
// per-statement metadata — it cannot prove which statements committed, and a
// nonzero exit can even FOLLOW a committed import (lost acknowledgement).
// Success is therefore CONFIRMED by re-reading D1 afterwards: the exact
// unique audit-marker id present AND the export row absent. Anything else is
// reported as refused/unconfirmed with ALL R2 objects retained.

/** One-pass placeholder rendering (F5): substitutes each `?` at its ORIGINAL
 *  position exactly once, so a legal-hold reason containing `?`, `$&`, `'`,
 *  or newlines can neither absorb later arguments nor be re-substituted. */
function renderSql(sql: string, args: unknown[]): string {
  const parts = sql.split("?");
  if (parts.length - 1 !== args.length) {
    throw new Error(
      `placeholder mismatch: ${parts.length - 1} placeholders vs ${args.length} args`,
    );
  }
  let out = parts[0] ?? "";
  for (let i = 0; i < args.length; i += 1) {
    out += esc(args[i] as string | number | null) + (parts[i + 1] ?? "");
  }
  return out;
}

console.log("\n[WRITE] executing deletion transaction...");
const plannedRow = exportRow as Record<string, unknown>;
const plannedStatus = String(plannedRow.status ?? "");
const auditId = globalThis.crypto.randomUUID();
const assertId = globalThis.crypto.randomUUID();
const stmts = buildExportDeletionStatements({
  exportId,
  month,
  plannedStatus,
  actor: ACTOR,
  nowIso: new Date().toISOString(),
  auditId,
  assertId,
  auditValueJson: plan.audit.newValueJson,
  plannedIdentity: {
    bundleBuildId: (plannedRow.bundle_build_id as string | null) ?? null,
    archiveKey: (plannedRow.archive_r2_key as string | null) ?? null,
    manifestKey: (plannedRow.manifest_r2_key as string | null) ?? null,
    proofsKey: (plannedRow.proofs_r2_key as string | null) ?? null,
  },
});
const sqlText = stmts.map((st) => renderSql(st.sql, st.args)).join(";\n");
const tmpFile = `/tmp/delete-sealed-export-${exportId}.sql`;
writeFileSync(tmpFile, sqlText + ";\n");

let importError: Error | null = null;
try {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--file", tmpFile],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
} catch (err) {
  // A nonzero exit does NOT prove rollback (the import may have committed
  // before the error/acknowledgement was lost) — confirmation below decides.
  importError = err instanceof Error ? err : new Error(String(err));
}
try { rmSync(tmpFile, { force: true }); } catch { /* best effort */ }

type ConfirmState =
  | { kind: "committed" }
  | { kind: "not-committed" }
  | { kind: "unreadable"; detail: string };

function confirmByRead(): ConfirmState {
  try {
    const markerRaw = execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        DB,
        "--remote",
        "--json",
        "--command",
        `SELECT id FROM receipt_audit_log WHERE id = ${esc(auditId)}`,
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    const rowRaw = execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        DB,
        "--remote",
        "--json",
        "--command",
        `SELECT id FROM receipt_exports WHERE id = ${esc(exportId)}`,
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    const markerRows = ((JSON.parse(markerRaw)[0] ?? JSON.parse(markerRaw))?.results ?? []) as unknown[];
    const rowRows = ((JSON.parse(rowRaw)[0] ?? JSON.parse(rowRaw))?.results ?? []) as unknown[];
    const markerPresent = markerRows.length === 1;
    const exportAbsent = rowRows.length === 0;
    if (markerPresent && exportAbsent) return { kind: "committed" };
    return { kind: "not-committed" };
  } catch (err) {
    return {
      kind: "unreadable",
      detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
    };
  }
}

const confirm = confirmByRead();
if (confirm.kind === "committed") {
  if (importError) {
    console.log("  [d1] import reported an error but the committed deletion is confirmed by re-read (commit-before-error acknowledged).");
  }
} else if (confirm.kind === "unreadable") {
  console.error(`  [d1] UNCONFIRMED: the deletion result could not be verified (${confirm.detail}). NO R2 object was touched — re-run the confirmation read before any retry; do NOT assume either outcome.`);
  process.exit(2);
} else if (importError) {
  console.error(`  [d1] REFUSED/ROLLED BACK: the deletion transaction did not commit (guard refusal or admission assertion). NOTHING was deleted and NO R2 object was touched.`);
  console.error(`  detail: ${importError.message.split("\n")[0]}`);
  process.exit(2);
} else {
  // Import reported success but the re-read does not show a committed
  // deletion — treat as unconfirmed, never as "unchanged" without evidence.
  console.error(`  [d1] UNCONFIRMED: the import returned but the committed state could not be verified by re-read (marker/export state unexpected). NO R2 object was touched — investigate before retrying.`);
  process.exit(2);
}
console.log("  [d1] deletion transaction CONFIRMED by re-read (unique audit marker present, export row absent; items cascaded, deliveries removed, admission audited)");

let removed = 0;
for (const key of plan.r2Objects) {
  if (r2Delete(key)) {
    removed++;
    console.log(`  [r2] deleted ${BUCKET}/${key}`);
  } else {
    console.log(`  [r2] absent (tolerated) ${BUCKET}/${key}`);
  }
}
console.log(`  [audit] export.deleted + admission recorded transactionally (removed ${removed} R2 object(s))`);
console.log(`\n[WRITE] done. R2 removed: ${removed}.`);
