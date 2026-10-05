#!/usr/bin/env -S npx tsx
// purge-orphan-amex-lines.ts — committed repair for ghost AMEX statement lines
// (TASK-037, live incident 2026-10-02/05).
//
// A ghost is an amex_statement_lines row whose statement_artifact_id no longer
// exists in amex_statement_artifacts. Population: the 2610 CSV was imported
// twice — first mis-slotted as statement month 2026-09 (artifact 40505298…),
// then correctly as 2026-10. The 2609 import flipped 40505298 to 'replaced'
// without touching its lines, and the next import's purge deleted the
// artifact row (the failed/replaced branch had no lines-exist guard, fixed in
// lib/receipts/db.ts by this task) — leaving 23 ghost lines in 2026-09.
//
// Operator rule: a charge NEVER appears on two AMEX statement months —
// cross-month duplicate lines are always import artifacts.
//
// How the planner runs it (Mac, wrangler-authenticated):
//   npx tsx scripts/purge-orphan-amex-lines.ts            # dry-run: reads + prints the plan
//   npx tsx scripts/purge-orphan-amex-lines.ts --apply    # executes it
//
// DB access: the RECEIPTS_DB binding that getReceiptsDb() resolves inside the
// Worker cannot be imported under tsx (it needs the OpenNext Cloudflare
// context), so — same as every script in this directory (delete-sealed-export.ts,
// repair-lifecycle-drift.ts, …) — we reach it with
// `wrangler d1 execute RECEIPTS_DB --remote`. Dry-run issues SELECTs only and
// changes nothing; every mutation requires the explicit --apply flag.
//
// Refuses by default on population drift: if the ghost set is not exactly the
// 23 lines of artifact 40505298… in month 2026-09, it prints the found list
// and aborts without touching anything. Confirmed/matched ghosts with no twin
// (same source_file_sha256 + raw_csv_line_number in another month, under a
// LIVE artifact) or with a twin matched to a different receipt are loudly
// refused and left in place.

import { execFileSync } from "node:child_process";

const DB = "RECEIPTS_DB";
const ACTOR = "purge-orphan-amex-lines.ts";
const REASON =
  "TASK-037 repair: delete 2026-09 ghost lines orphaned when the replaced " +
  "2610 artifact 40505298… was purged with lines still attached; retarget " +
  "reconciliation state to the correctly-slotted 2026-10 twins.";

// Expected ghost population (from the 2026-10-05 D1 verification).
const EXPECTED_ARTIFACT_PREFIX = "40505298";
const EXPECTED_MONTH = "2026-09";
const EXPECTED_COUNT = 23;

const APPLY = process.argv.slice(2).includes("--apply");

const esc = (v: string | null | undefined) =>
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

function d1run(sql: string): number {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  const top = Array.isArray(parsed) ? parsed[0] : parsed;
  return top?.meta?.changes ?? 0;
}

interface GhostLine {
  id: string;
  statement_month: string;
  transaction_date: string;
  merchant: string;
  amount_minor: number;
  match_status: string;
  matched_receipt_id: string | null;
  receipt_status: string;
  receipt_missing_reason: string | null;
  source_file_sha256: string | null;
  raw_csv_line_number: number | null;
  statement_artifact_id: string;
}

interface TwinLine {
  id: string;
  statement_month: string;
  matched_receipt_id: string | null;
  match_status: string;
}

// ─── (a) Find ghosts; abort on population drift ──────────────────────────────
const ghosts = d1(
  `SELECT l.id, l.statement_month, l.transaction_date, l.merchant, l.amount_minor,
          l.match_status, l.matched_receipt_id, l.receipt_status, l.receipt_missing_reason,
          l.source_file_sha256, l.raw_csv_line_number, l.statement_artifact_id
   FROM amex_statement_lines l
   WHERE l.statement_artifact_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM amex_statement_artifacts a WHERE a.id = l.statement_artifact_id
     )
   ORDER BY l.statement_month, l.raw_csv_line_number`,
) as unknown as GhostLine[];

if (ghosts.length === 0) {
  console.log("No ghost lines found (no line references a missing artifact). Nothing to do.");
  process.exit(0);
}

const drift = ghosts.filter(
  (g) =>
    !g.statement_artifact_id.startsWith(EXPECTED_ARTIFACT_PREFIX) ||
    g.statement_month !== EXPECTED_MONTH ||
    ghosts.length !== EXPECTED_COUNT,
);
if (drift.length > 0 || ghosts.length !== EXPECTED_COUNT) {
  console.error(
    `ABORT: ghost population does not match the TASK-037 description ` +
      `(expected exactly ${EXPECTED_COUNT} lines of artifact ${EXPECTED_ARTIFACT_PREFIX}… ` +
      `in month ${EXPECTED_MONTH}; found ${ghosts.length}). Touching nothing. Found list:`,
  );
  for (const g of ghosts) {
    console.error(
      `  ${g.id} month=${g.statement_month} artifact=${g.statement_artifact_id} ` +
        `csv_line=${g.raw_csv_line_number} ${g.merchant} ${g.amount_minor} ${g.match_status}`,
    );
  }
  process.exit(1);
}

const ghostSha = ghosts[0].source_file_sha256;

// ─── (b) Plan: retarget twins of confirmed/matched ghosts, or refuse ─────────
interface PlannedAction {
  ghost: GhostLine;
  kind: "retarget" | "delete" | "refused";
  reason?: string;
  twin?: TwinLine;
}

const plan: PlannedAction[] = [];
for (const ghost of ghosts) {
  if (ghost.match_status !== "confirmed" && ghost.match_status !== "matched") {
    plan.push({ ghost, kind: "delete" });
    continue;
  }

  const twins = d1(
    `SELECT id, statement_month, matched_receipt_id, match_status
     FROM amex_statement_lines
     WHERE source_file_sha256 = ${esc(ghost.source_file_sha256)}
       AND raw_csv_line_number = ${ghost.raw_csv_line_number ?? "NULL"}
       AND statement_month != ${esc(ghost.statement_month)}
       AND EXISTS (
         SELECT 1 FROM amex_statement_artifacts a
          WHERE a.id = amex_statement_lines.statement_artifact_id
       )
     LIMIT 2`,
  ) as unknown as TwinLine[];

  if (twins.length === 0) {
    plan.push({
      ghost,
      kind: "refused",
      reason: `match_status=${ghost.match_status} (receipt ${ghost.matched_receipt_id}) but NO twin under a live artifact — refusing to delete a reconciled line`,
    });
    continue;
  }
  if (twins.length > 1) {
    plan.push({
      ghost,
      kind: "refused",
      reason: `ambiguous: ${twins.length} twins share sha+csv_line — refusing to pick one`,
    });
    continue;
  }
  const twin = twins[0];
  if (twin.matched_receipt_id && twin.matched_receipt_id !== ghost.matched_receipt_id) {
    plan.push({
      ghost,
      kind: "refused",
      reason: `twin ${twin.id} (${twin.statement_month}) is ${twin.match_status} to a DIFFERENT receipt ${twin.matched_receipt_id} than the ghost's ${ghost.matched_receipt_id} — manual decision needed`,
    });
    continue;
  }
  // Twin is unmatched (or already reconciled to the same receipt): copy the
  // ghost's reconciliation state onto it, then the ghost is redundant.
  plan.push({ ghost, kind: "retarget", twin });
}

// ─── (e) Summary table ────────────────────────────────────────────────────────
console.log(`Ghost lines (${ghosts.length}, artifact ${ghosts[0].statement_artifact_id}, month ${EXPECTED_MONTH}, sha ${ghostSha}):`);
for (const a of plan) {
  const g = a.ghost;
  const tag =
    a.kind === "retarget"
      ? `RETARGET twin ${a.twin!.id} (${a.twin!.statement_month}) then delete`
      : a.kind === "delete"
        ? "DELETE"
        : `REFUSED: ${a.reason}`;
  console.log(
    `  csv_line=${g.raw_csv_line_number} ${g.merchant} ¥${g.amount_minor} ` +
      `${g.transaction_date} [${g.match_status}${g.matched_receipt_id ? ` ${g.matched_receipt_id.slice(0, 8)}…` : ""}] → ${tag}`,
  );
}

const refused = plan.filter((a) => a.kind === "refused");
console.log(
  `\nPlan: ${plan.filter((a) => a.kind === "retarget").length} retarget+delete, ` +
    `${plan.filter((a) => a.kind === "delete").length} plain delete, ${refused.length} refused.`,
);

if (!APPLY) {
  console.log("\n[dry-run] no changes made. Re-run with --apply to execute.");
  process.exit(0);
}

// ─── Execute ──────────────────────────────────────────────────────────────────
console.log("\n[apply] executing...");
const retargets: Record<string, unknown>[] = [];
for (const a of plan) {
  if (a.kind === "retarget") {
    const g = a.ghost;
    const changed = d1run(
      `UPDATE amex_statement_lines SET
         matched_receipt_id = ${esc(g.matched_receipt_id)},
         match_status = ${esc(g.match_status)},
         receipt_status = ${esc(g.receipt_status)},
         receipt_missing_reason = ${esc(g.receipt_missing_reason)},
         updated_at = ${esc(new Date().toISOString())}
       WHERE id = ${esc(a.twin!.id)}`,
    );
    if (changed !== 1) {
      console.error(`  ABORT: retarget of twin ${a.twin!.id} changed ${changed} rows (expected 1). Stopping.`);
      process.exit(2);
    }
    retargets.push({
      ghostId: g.id,
      twinId: a.twin!.id,
      twinMonth: a.twin!.statement_month,
      matched_receipt_id: g.matched_receipt_id,
      match_status: g.match_status,
    });
    console.log(`  [d1] retargeted twin ${a.twin!.id} ← ghost ${g.id} (${g.match_status})`);
  }
}

let deleted = 0;
for (const a of plan) {
  if (a.kind === "refused") continue;
  const changed = d1run(`DELETE FROM amex_statement_lines WHERE id = ${esc(a.ghost.id)}`);
  if (changed !== 1) {
    console.error(`  ABORT: delete of ghost ${a.ghost.id} changed ${changed} rows (expected 1). Stopping.`);
    process.exit(2);
  }
  deleted++;
}
console.log(`  [d1] deleted ${deleted} ghost line(s) (amex_line_attendees cascade via FK)`);

// ─── (d) Audit ────────────────────────────────────────────────────────────────
const ghostIds = plan.filter((a) => a.kind !== "refused").map((a) => a.ghost.id);
if (ghostIds.length > 0) {
  d1run(
    `INSERT INTO receipt_audit_log
       (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
     VALUES (
       ${esc(globalThis.crypto.randomUUID())},
       ${esc(ACTOR)},
       'amex_statement.orphan_lines_purged',
       'amex_statement_line',
       ${esc(ghostIds.join(","))},
       NULL,
       ${esc(
         JSON.stringify({
           reason: REASON,
           sha256: ghostSha,
           deletedGhostIds: ghostIds,
           retargets,
           refused: refused.map((a) => ({ ghostId: a.ghost.id, reason: a.reason })),
         }),
       )},
       ${esc(new Date().toISOString())})`,
  );
  console.log(`  [audit] wrote amex_statement.orphan_lines_purged for ${ghostIds.length} line(s)`);
}

if (refused.length > 0) {
  console.error(
    `\n[apply] COMPLETED WITH REFUSALS: ${refused.length} confirmed/matched ghost line(s) were NOT deleted:`,
  );
  for (const a of refused) console.error(`  ${a.ghost.id}: ${a.reason}`);
  process.exit(1);
}
console.log(`\n[apply] done. Retargets: ${retargets.length}. Deleted: ${deleted}.`);
