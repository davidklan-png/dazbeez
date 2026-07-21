#!/usr/bin/env -S npx tsx
// Hardened, auditability-committed version of the 2026-07-21 lifecycle-drift
// repair (operator/architect approval, item 2 ONLY).
//
// ⚠️ THE PRODUCTION RUN ALREADY OCCURRED before this script was committed:
//   22 receipts were repaired reviewed → reconciled (see the `receipt.updated`
//   audit rows by the `repair-lifecycle-drift.ts` actor, 2026-07-21). This
//   hardened version exists for SAFE FUTURE RERUNS and the audit trail.
//
// SAFETY vs the one-shot run (protects against unsafe future reruns):
//   1. FROZEN ALLOWLIST of the 22 approved receipt IDs. A later run CANNOT
//      repair newly-appearing drift rows — those require FRESH operator/
//      architect approval (and a new/edited script). Out-of-allowlist drift is
//      REPORTED but NOT repaired.
//   2. The write-time UPDATE carries the confirmed-line EXISTS predicate, the
//      pre-recon status set, deleted_at IS NULL, AND an optimistic updated_at
//      before-state guard — so it only fires on an unchanged, eligible row.
//   3. The audit row is inserted ONLY when the UPDATE changed EXACTLY ONE row
//      (meta.changes === 1); otherwise the row is untouched and reported as a
//      no-op (guard held / already repaired). meta.changes is used because D1's
//      CLI does not reliably surface changes() across statements in one command.
//   4. ACTUAL changed rows are reported (not attempted rows).
//
// Scope: non-deleted receipts claimed by a CONFIRMED AMEX line whose status is
// captured/needs_review/reviewed → reconciled. NEVER changes reconciled/exported/
// archived rows (the UPDATE WHERE restricts to pre-recon statuses). No deletes,
// payment-path, match, or statement changes. Direct D1 repair — NOT match
// reconfirmation (reconfirming can be blocked by finalized-reconciliation locks
// and needlessly rewrites/audits the AMEX line).
//
// WHERE THIS RUNS: the Mac, with live Cloudflare bindings — shells out to
// `wrangler d1 execute RECEIPTS_DB --remote`. Idempotent. Dry-run by default;
// --write to persist.
//
//   npx tsx scripts/repair-lifecycle-drift.ts            # dry-run
//   npx tsx scripts/repair-lifecycle-drift.ts --write    # persist

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const DB = "RECEIPTS_DB";
const ACTOR =
  "repair-lifecycle-drift.ts (operator-approved lifecycle-drift repair, item 2, 2026-07-21; hardened)";
const WRITE = process.argv.slice(2).includes("--write");
const PRE_RECON: readonly string[] = ["captured", "needs_review", "reviewed"];

// FROZEN: the 22 receipts approved for lifecycle-drift repair on 2026-07-21.
// DO NOT add IDs without fresh operator/architect approval — a new drift
// population requires a separate approval and a new/edited script.
const ALLOWLIST: readonly string[] = [
  "0753c5c0-95ac-43c4-9d4e-5a8b9f5f99bd",
  "0eb3d0a5-b8e4-42ee-87f0-eba975d3c639",
  "1d581ee4-909e-4335-b7c0-36ac0f6f2e15",
  "334078db-34d4-4e5e-bcf9-4e5127088de1",
  "5c1ab53f-b90b-4ba2-8e9a-98cd8e5dd2ee",
  "69d2e368-da5a-42f9-9908-617032ef08f7",
  "77e95ba2-4410-4e1e-809a-e338f24d7461",
  "8d71768d-c11b-46b6-b381-e46ec3a63f8b",
  "8f618bed-b581-46b4-a74c-6dd71831b26d",
  "976ec9ec-bf88-43fc-ac9c-c7990e5ed0df",
  "9ee39a10-9193-48dc-8b63-a198727161ea",
  "a6d861c0-87b0-46cd-81b9-c360f6657c26",
  "b1cafd08-d396-4d18-9f81-2752a5e6c6f3",
  "c199475e-00ce-4be7-82d7-30b627d695b7",
  "d5ee7d3e-cc8d-4c60-bb55-1437bc52e1bd",
  "e57f90b3-1a1c-49b6-ab70-9d781d89f75b",
  "f338123a-16d2-482f-92c9-d3bf61784430",
  "f3e866f6-7d77-43d6-8c4a-3f6c86f4825c",
  "f457ab9f-926a-4ff9-9beb-97c190634497",
  "f6bcbe72-80ab-461f-948d-a15e7a27960c",
  "fd4d0bd3-d56e-40e5-a4e7-e5a283657545",
  "fdb3b313-a210-4d21-9383-234968cf8785",
];

function d1(sql: string): { results: Record<string, unknown>[]; changes: number } {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  const top = Array.isArray(parsed) ? parsed[0] : parsed;
  return { results: top?.results ?? [], changes: top?.meta?.changes ?? 0 };
}

const esc = (v: unknown) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const escId = (id: string) => id.replace(/'/g, "''");
const inList = (ids: readonly string[]) => ids.map((i) => `'${escId(i)}'`).join(",");

// Diagnostic: any current drift OUTSIDE the frozen allowlist? Reported, NOT
// repaired — it needs fresh approval.
const drift = d1(
  `SELECT rr.id, rr.status FROM receipt_records rr
    WHERE rr.deleted_at IS NULL AND rr.status IN ('captured','needs_review','reviewed')
      AND EXISTS (SELECT 1 FROM amex_statement_lines l
                   WHERE l.matched_receipt_id = rr.id AND l.match_status = 'confirmed');`,
);
const outside = drift.results
  .map((r) => r.id as string)
  .filter((id) => !(ALLOWLIST as readonly string[]).includes(id));
if (outside.length > 0) {
  console.log(
    `⚠ ${outside.length} drift row(s) NOT in the frozen allowlist — NOT repaired (require fresh approval):\n` +
      outside.map((id) => `    ${id.slice(0, 8)}`).join("\n") +
      "\n",
  );
}

console.log(
  `Frozen allowlist: ${ALLOWLIST.length} receipt(s)` +
    `${WRITE ? " [WRITE]" : " [DRY-RUN — re-run with --write to persist]"}\n`,
);

let changed = 0;
let noops = 0;
let missing = 0;
for (const id of ALLOWLIST) {
  // Before-state (source of the optimistic updated_at guard + the audit old row).
  const b = d1(
    `SELECT * FROM receipt_records WHERE id = '${escId(id)}' AND deleted_at IS NULL LIMIT 1;`,
  );
  if (b.results.length === 0) {
    console.log(`✖ ${id.slice(0, 8)}: not found / deleted — skip.`);
    missing++;
    continue;
  }
  const before = b.results[0]!;
  if (!PRE_RECON.includes(before.status as string)) {
    console.log(`• ${id.slice(0, 8)}: status ${before.status} (not pre-recon) — no-op.`);
    noops++;
    continue;
  }
  // Re-assert the confirmed claim (also enforced inside the UPDATE below).
  const claims = d1(
    `SELECT statement_month FROM amex_statement_lines
       WHERE matched_receipt_id = '${escId(id)}' AND match_status = 'confirmed';`,
  );
  if (claims.results.length === 0) {
    console.log(`✖ ${id.slice(0, 8)}: no confirmed AMEX line (anymore) — skip.`);
    missing++;
    continue;
  }
  const confirmedMonths = claims.results.map((c) => c.statement_month).join(",");
  const expectedUpdated = before.updated_at as string;
  const now = new Date().toISOString();
  const oldJson = JSON.stringify(before);
  const newJson = JSON.stringify({
    status: "reconciled",
    repairReason:
      `Lifecycle drift repair: receipt has a confirmed AMEX line (${confirmedMonths}) ` +
      `but status was "${before.status}". Restored to reconciled via direct D1 repair ` +
      `(no match reconfirmation).`,
    confirmedMonths,
  });

  console.log(
    `• ${id.slice(0, 8)}  (${before.merchant})  ${before.status} -> reconciled  (confirmed-in: ${confirmedMonths})`,
  );
  if (!WRITE) continue;

  // Conditional UPDATE: id + non-deleted + pre-recon status + optimistic
  // updated_at before-state guard + confirmed-line EXISTS predicate.
  const upd = d1(
    `UPDATE receipt_records
        SET status = 'reconciled', updated_at = '${now}'
      WHERE id = '${escId(id)}'
        AND deleted_at IS NULL
        AND status IN ('captured','needs_review','reviewed')
        AND updated_at = '${escId(expectedUpdated)}'
        AND EXISTS (SELECT 1 FROM amex_statement_lines l
                     WHERE l.matched_receipt_id = '${escId(id)}' AND l.match_status = 'confirmed');`,
  );
  if (upd.changes === 1) {
    // Audit ONLY when exactly one row changed.
    d1(
      `INSERT INTO receipt_audit_log
         (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
       VALUES
         ('${randomUUID()}', ${esc(ACTOR)}, 'receipt.updated', 'receipt', '${escId(id)}',
          ${esc(oldJson)}, ${esc(newJson)}, '${now}');`,
    );
    changed++;
    console.log(`    [changed 1 + audited]`);
  } else {
    noops++;
    console.log(
      `    [UPDATE changed ${upd.changes} row(s) — no-op (guard held / already repaired); audit NOT written]`,
    );
  }
}

console.log(
  `\n${WRITE ? "Changed" : "Would change"}: ${changed} | no-op: ${noops} | missing: ${missing} (of ${ALLOWLIST.length} allowlisted)`,
);

if (WRITE) {
  // Post-verify: no ALLOWLISTED confirmed receipt remains pre-recon. (Drift
  // outside the allowlist is reported above and intentionally left in place.)
  const remain = d1(
    `SELECT COUNT(*) AS n FROM receipt_records rr
      WHERE rr.deleted_at IS NULL AND rr.status IN ('captured','needs_review','reviewed')
        AND rr.id IN (${inList(ALLOWLIST)})
        AND EXISTS (SELECT 1 FROM amex_statement_lines l
                     WHERE l.matched_receipt_id = rr.id AND l.match_status = 'confirmed');`,
  );
  console.log(
    `Post-verify (allowlist): ${remain.results[0]?.n ?? "?"} allowlisted confirmed receipt(s) still pre-recon.`,
  );
}
console.log(`\nDone.`);
