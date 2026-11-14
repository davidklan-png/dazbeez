// Seal boundary round 3 — the ACTUAL deletion CLI under a Wrangler-shaped
// npx shim (F4/F5). The committed script executes end-to-end as a real
// subprocess; only `npx` is intercepted, so the exact transport contract is
// exercised:
//
//   * `wrangler d1 execute --remote --json --file <f>` returns Wrangler
//     4.83.0's file-import shape: a SINGLE AGGREGATE result (stats row +
//     aggregate meta), NOT per-statement metadata — the bug F4 exposed.
//   * A nonzero exit can FOLLOW a committed import (lost acknowledgement).
//   * Confirmation re-reads use `--command`, whose per-statement JSON is
//     well-formed.
//
// Success is confirmed ONLY by the unique audit identity present AND the
// export row absent; everything else is refused/unconfirmed with R2 retained.
// F5's placeholder rendering is verified on the CAPTURED sql file: a
// legal-hold reason containing `?`, `$&`, apostrophes and newlines must
// round-trip verbatim with no stray placeholders.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = join(process.cwd(), "scripts", "delete-sealed-export.ts");

/**
 * Wrangler-shaped npx shim (node script, dispatched by argv):
 *  - planning reads: `--command "SELECT * FROM receipt_exports WHERE id…"` →
 *    the planned row; deliveries → [].
 *  - file import: prints the AGGREGATE result (success) or exits 1
 *    (committed | rolledback per scenario).
 *  - confirmation reads: audit-marker SELECT → [id] when committed else [];
 *    export-row SELECT → [] when committed else [row]; `unreadable` exits 1.
 *  - `r2 object delete` → appends the key to r2.log.
 */
function writeShim(dir: string, scenario: {
  fileImport: "aggregate-success" | "exit1-committed" | "exit1-rolledback" | "exit1-late-commit" | "exit1-econnrefused";
  confirm: "committed" | "rolledback" | "unreadable" | "inconsistent" | "late-commit";
  /** The combined confirmation query's single row (marker_n, export_n). */
  confirmState?: { marker_n: number; export_n: number };
  exportRow: Record<string, unknown>;
}): void {
  const shim = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2); // wrangler ...
const cmdIdx = args.indexOf("--command");
const fileIdx = args.indexOf("--file");
const capture = process.env.WR_SHIM_DIR;
function out(o) { process.stdout.write(JSON.stringify([o])); }
const CONFIRM_STATE = CONFIRM_STATE_JSON;
if (args.includes("object") && args.includes("delete")) {
  const key = args[args.length - 2];
  fs.appendFileSync(join0(capture, "r2.log"), key + "\\n");
  process.exit(0);
}
if (fileIdx >= 0) {
  const f = args[fileIdx + 1];
  fs.copyFileSync(f, join0(capture, "import-" + fs.readdirSync(capture).length + ".sql"));
  if (${JSON.stringify(scenario.fileImport)} === "exit1-econnrefused") {
    // R5-1: an ordinary CONNECTION failure while polling the running D1
    // import — the transaction may still commit (arm the late-commit sentinel
    // so the first combined read observes PRE-commit state). Contains no
    // rejection signature ("ECONNREFUSED" is not one).
    fs.writeFileSync(join0(capture, "late-commit"), "pending");
    process.stderr.write("wrangler: exit 1 - fetch failed: connect ECONNREFUSED 127.0.0.1:443 while polling running D1 import" + String.fromCharCode(10));
    process.exit(1);
  }
  if (${JSON.stringify(scenario.fileImport)} === "exit1-late-commit") {
    // Lost acknowledgement: the import STARTED, exited 1, and the deletion
    // transaction commits AFTER the operator's first confirmation read runs.
    fs.writeFileSync(join0(capture, "late-commit"), "pending");
    process.stderr.write("wrangler: exit 1 (acknowledgement lost)" + String.fromCharCode(10));
    process.exit(1);
  }
  if (${JSON.stringify(scenario.fileImport)} === "aggregate-success") {
    // Wrangler 4.83.0 file-import shape: ONE aggregate result.
    out({ results: [{ duration_ms: 12.3, rows_read: 9, rows_written: 9 }], meta: { changes: 0, duration_ms: 12.3, rows_read: 9, rows_written: 9, total_changes: 9 } });
    process.exit(0);
  }
  // A DEFINITE statement/admission rejection carries the constraint text.
  process.stderr.write("wrangler: exit 1 - D1_ERROR: NOT NULL constraint failed: receipt_audit_log.actor (admission refusal)" + String.fromCharCode(10));
  process.exit(1);
}
if (cmdIdx >= 0) {
  const sql = args[cmdIdx + 1];
  if (/SELECT \\* FROM receipt_exports WHERE id/.test(sql)) {
    // Planning read: ALWAYS returns the planned row.
    out({ results: ${JSON.stringify([scenario.exportRow])} });
    process.exit(0);
  }
  if (sql.includes("AS marker_n") && sql.includes("AS export_n")) {
    // Single combined confirmation query (marker + parent observed together).
    if (${JSON.stringify(scenario.confirm)} === "unreadable") { process.stderr.write("d1 unavailable" + String.fromCharCode(10)); process.exit(1); }
    if (${JSON.stringify(scenario.confirm)} === "late-commit") {
      // First read observes pre-commit state; the deletion lands after it.
      const p = join0(capture, "late-commit");
      if (fs.existsSync(p)) { fs.rmSync(p); out({ results: [{ marker_n: 0, export_n: 1 }] }); process.exit(0); }
      out({ results: [{ marker_n: 1, export_n: 0 }] });
      process.exit(0);
    }
    out({ results: [CONFIRM_STATE] });
    process.exit(0);
  }
  if (sql.includes("FROM receipt_audit_log WHERE id")) {
    if (${JSON.stringify(scenario.confirm)} === "unreadable") { process.stderr.write("d1 unavailable" + String.fromCharCode(10)); process.exit(1); }
    out({ results: ${JSON.stringify(scenario.confirm === "committed" ? [{ id: "planned-audit-id" }] : [])} });
    process.exit(0);
  }
  if (sql.includes("FROM export_deliveries")) { out({ results: [] }); process.exit(0); }
  out({ results: [] });
  process.exit(0);
}
function join0(a, b) { return a + "/" + b; }
`;
  writeFileSync(
    join(dir, "npx"),
    shim.replace("CONFIRM_STATE_JSON", JSON.stringify(scenario.confirmState ?? { marker_n: 0, export_n: 1 })),
    { mode: 0o755 },
  );
}

function runCli(scenario: {
  fileImport: "aggregate-success" | "exit1-committed" | "exit1-rolledback" | "exit1-late-commit" | "exit1-econnrefused";
  confirm: "committed" | "rolledback" | "unreadable" | "inconsistent" | "late-commit";
  confirmState?: { marker_n: number; export_n: number };
  reason?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "dse-cli-"));
  const exportRow = {
    id: "exp-1",
    export_month: "2026-06",
    status: "finalized",
    archive_r2_key: "exports/2026-06/exp-1-old/receipts.csv",
    manifest_r2_key: "exports/2026-06/exp-1-old/manifest.csv",
    proofs_r2_key: null,
    bundle_build_id: "build-1",
    retention_until: "t",
    legal_hold: 1,
  };
  const confirmState =
    scenario.confirmState ??
    (scenario.confirm === "committed"
      ? { marker_n: 1, export_n: 0 }
      : { marker_n: 0, export_n: 1 });
  writeShim(dir, { ...scenario, exportRow, confirmState });
  const reason = scenario.reason ?? "test cleanup";
  const res = spawnSync(
    process.execPath,
    [
      TSX,
      SCRIPT,
      "--export-id", "exp-1",
      "--month", "2026-06",
      "--reason", reason,
      "--write",
      "--confirm-delete", "exp-1",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        WR_SHIM_DIR: dir,
      },
    },
  );
  const r2Log = existsSync(join(dir, "r2.log")) ? readFileSync(join(dir, "r2.log"), "utf8").trim() : "";
  const imports = fsreaddir(dir).filter((f) => f.startsWith("import-")).sort().map((f) => readFileSync(join(dir, f), "utf8"));
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, r2Log, imports, dir };
}

function fsreaddir(d: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- tiny local helper avoids an import cycle in the shim-based runner
  return require("node:fs").readdirSync(d) as string[];
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("CLI aggregate-success + committed confirmation proceeds to R2 deletion", () => {
  const r = runCli({ fileImport: "aggregate-success", confirm: "committed" });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /CONFIRMED by re-read/);
    assert.match(r.stdout, /deliveries removed/);
    const keys = r.r2Log ? r.r2Log.split("\n") : [];
    assert.equal(keys.length, 9, "all planned stored+derived keys removed");
    assert.ok(keys.every((k) => k.startsWith("dazbeez-receipts-archive/")), "shim logs the full object path");
    assert.ok(keys.some((k) => k.endsWith("exp-1-old/receipts.csv")), "stored archive key removed");
    assert.ok(keys.some((k) => k.endsWith("exp-1-old/manifest.csv")), "stored manifest key removed");
    assert.ok(keys.some((k) => k.endsWith("/build-1/exp-1-proofs-noreceipts.zip")), "build-namespaced derived key removed");
  } finally { cleanup(r.dir); }
});

test("CLI aggregate-success but state shows not-committed reports ROLLED BACK and retains R2", () => {
  // Import returned success, no import error, and the combined read shows
  // marker absent + export present: the transaction definitely did not commit.
  const r = runCli({ fileImport: "aggregate-success", confirm: "rolledback" });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /REFUSED\/ROLLED BACK/);
    assert.ok(!/UNCONFIRMED/.test(r.stdout + r.stderr), "a clean not-committed read with a successful import is a definite refusal, not uncertainty");
    assert.equal(r.r2Log, "", "no R2 object touched");
  } finally { cleanup(r.dir); }
});

test("CLI commit-before-error: file import exits 1 but the committed deletion is confirmed and R2 proceeds", () => {
  const r = runCli({ fileImport: "exit1-committed", confirm: "committed" });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /commit-before-error acknowledged/);
    assert.equal(r.r2Log.split("\n").length, 9, "R2 deletion ran after confirmed commit");
  } finally { cleanup(r.dir); }
});

test("CLI rolled-back import (definite admission rejection) reports REFUSED/ROLLED BACK and retains R2", () => {
  const r = runCli({ fileImport: "exit1-rolledback", confirm: "rolledback" });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /REFUSED\/ROLLED BACK/);
    assert.ok(!/UNCONFIRMED/.test(r.stdout + r.stderr), "a definite rejection is NOT reported unconfirmed");
    assert.equal(r.r2Log, "");
  } finally { cleanup(r.dir); }
});

test("CLI R3 late commit between reads: unclassified import error + absent-now state is UNCONFIRMED, never a claimed rollback", () => {
  // The import lost its acknowledgement (exit 1, unclassified). The combined
  // confirmation read happens BEFORE the deletion transaction lands and
  // observes marker-absent/export-present — absence now does NOT prove the
  // pending import cannot commit later. The CLI must report UNCONFIRMED.
  const r = runCli({ fileImport: "exit1-late-commit", confirm: "late-commit" });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /UNCONFIRMED/);
    assert.ok(!/ROLLED BACK/.test(r.stdout + r.stderr), "must NOT claim a definite rollback on unresolved evidence");
    assert.equal(r.r2Log, "", "R2 retained");
  } finally { cleanup(r.dir); }
});

test("CLI R5-1 ECONNREFUSED during import polling is UNCONFIRMED, never a claimed rollback", () => {
  // Reviewer probe (round-4 review, finding 1): the import subprocess dies
  // with a connection refusal mid-poll; the combined confirmation read
  // observes marker-absent/export-present (pre-commit). A network error is
  // NOT rejection evidence — the deletion may commit after the read — so the
  // only honest outcome is UNCONFIRMED with R2 retained. (Before R5-1 the
  // classifier's /REFUSED/ alternative matched "ECONNREFUSED" and the CLI
  // falsely printed REFUSED/ROLLED BACK.)
  const r = runCli({ fileImport: "exit1-econnrefused", confirm: "late-commit" });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /UNCONFIRMED/);
    assert.ok(!/ROLLED BACK/.test(r.stdout + r.stderr), "must NOT claim definite rollback on a connection error");
    assert.ok(!/REFUSED\//.test(r.stdout + r.stderr));
    assert.equal(r.r2Log, "", "R2 retained");
  } finally { cleanup(r.dir); }
});

test("CLI R5-1 ECONNREFUSED with a plain absent-now read is also UNCONFIRMED", () => {
  // Same class, static read: absence now still cannot prove a pending import
  // will never commit.
  const r = runCli({ fileImport: "exit1-econnrefused", confirm: "rolledback", confirmState: { marker_n: 0, export_n: 1 } });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /UNCONFIRMED/);
    assert.ok(!/ROLLED BACK/.test(r.stdout + r.stderr));
    assert.equal(r.r2Log, "");
  } finally { cleanup(r.dir); }
});

test("CLI R3 inconsistent confirmation state is UNCONFIRMED", () => {
  // marker present AND export still present: not committed, not provably
  // rolled back — an in-flight or partially observed state.
  const r = runCli({ fileImport: "exit1-rolledback", confirm: "inconsistent", confirmState: { marker_n: 1, export_n: 1 } });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /UNCONFIRMED/);
    assert.equal(r.r2Log, "");
  } finally { cleanup(r.dir); }
});

test("CLI unreadable confirmation reports UNCONFIRMED and retains R2", () => {
  const r = runCli({ fileImport: "aggregate-success", confirm: "unreadable" });
  try {
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /UNCONFIRMED/);
    assert.equal(r.r2Log, "");
  } finally { cleanup(r.dir); }
});

test("CLI F5 placeholder rendering: a reason with ?, $&, apostrophes and newlines round-trips verbatim with no stray placeholders", () => {
  const reason = "cleanup? confirmed\noperator's note $& $1 `back`";
  const r = runCli({ fileImport: "aggregate-success", confirm: "committed", reason });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.imports.length, 1, "exactly one file import");
    const sql = r.imports[0]!;
    // The marker statement (first statement in the file) must embed the JSON
    // payload verbatim: the '?' and '$&' survive literally, the apostrophe is
    // SQL-escaped exactly once, the newline survives inside the string.
    const markerStmt = sql.slice(0, sql.indexOf("DELETE FROM export_deliveries"));
    assert.ok(markerStmt.includes("export.deleted"), "marker present");
    assert.ok(markerStmt.includes("cleanup? confirmed"), "literal ? preserved in the reason");
    assert.ok(markerStmt.includes("operator''s note $& $1 `back`"), "apostrophe escaped once; $ sequences literal");
    assert.ok(markerStmt.includes("\\n"), "newline preserved (JSON-escaped inside the SQL string)");
    // No UNRENDERED placeholders: strip the two verbatim reason occurrences
    // (the only legal ? in the file), then no ? may remain anywhere.
    const escapedReason = "cleanup? confirmed\\noperator''s note $& $1 `back`";
    const stripped = sql.split(escapedReason).join("");
    assert.equal((stripped.match(/\?/g) ?? []).length, 0, "no unconsumed ? placeholders anywhere");
  } finally { cleanup(r.dir); }
});

test("CLI F5 rendered SQL actually EXECUTES against the full schema with the tricky reason (round-trip + cascade + admission)", () => {
  const reason = "cleanup? confirmed\noperator's note $& $1 `back`";
  const r = runCli({ fileImport: "aggregate-success", confirm: "committed", reason });
  try {
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.imports.length, 1);
    const sql = r.imports[0]!;
    // Execute the rendered file on a real full-migration SQLite database in
    // one explicit transaction — the exact bytes the CLI would have shipped.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- node:sqlite has no typings in this @types/node
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { get(...a: unknown[]): Record<string, unknown> | undefined } } };
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const f of readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort()) {
      db.exec(readFileSync(`db/receipts/${f}`, "utf8"));
    }
    db.exec(`INSERT INTO receipt_records (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at) VALUES ('r1','t','a','CASH','2026-06-10','reviewed','k','s','image/jpeg',1,'t','t')`);
    db.exec(`INSERT INTO receipt_exports (id,export_month,status,created_by,created_at,retention_until,legal_hold,export_revision,bundle_build_id,archive_r2_key,manifest_r2_key,proofs_r2_key) VALUES ('exp-1','2026-06','draft','a','t','t',1,1,'build-1','exports/2026-06/exp-1-old/receipts.csv','exports/2026-06/exp-1-old/manifest.csv',NULL)`);
    db.exec(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i1','exp-1','receipt','r1','t')`);
    db.exec(`UPDATE receipt_exports SET status='finalized' WHERE id='exp-1'`);
    db.exec("BEGIN");
    for (const stmt of sql.split(";\n")) {
      if (stmt.trim()) db.exec(stmt + ";");
    }
    db.exec("COMMIT");
    const marker = db.prepare(`SELECT new_value_json FROM receipt_audit_log WHERE action='export.deleted'`).get() as { new_value_json: string } | undefined;
    assert.ok(marker, "marker committed");
    assert.equal(JSON.parse(marker!.new_value_json).reason, reason, "reason round-trips verbatim");
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports`).get()?.n, 0, "export deleted");
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items`).get()?.n, 0, "items cascaded");
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_audit_log WHERE action='export.deleted.admitted'`).get()?.n, 1, "admission audit committed");
  } finally { cleanup(r.dir); }
});
