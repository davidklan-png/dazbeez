// Revision-flow data-integrity test (PR 4).
//
// The June 2026 rev-2 path depends on: createExportRevision inserts a revision-2
// draft that supersedes a finalized rev-1, then finalizeExport flips ONLY the
// rev-2 row — rev-1 must stay byte-identical (sealed-data preservation).
//
// This is DB-level behavior, so it runs against LOCAL D1 via wrangler (the repo
// has no D1-in-tests harness). It is GATED: skipped in `npm test` (no wrangler
// spawning in CI), and run explicitly with D1_INTEGRATION=1 to prove the flow:
//
//   D1_INTEGRATION=1 npx tsx --test tests/receipts/export-revision-flow.test.ts
//
// The SQL issued here mirrors createExportRevision (db.ts:2047) and
// finalizeExport (db.ts:1919) exactly, against the migration-defined schema.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";

const RUN = process.env.D1_INTEGRATION === "1";
const TEST_MONTH = "2099-12"; // a far-future month that never collides with real data

function d1(sql: string): Array<Record<string, unknown>> {
  // Pass args as an array (execFileSync) so the SQL — which contains Japanese
  // text and quotes — is never re-parsed by a shell.
  const raw = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "RECEIPTS_DB",
      "--local",
      "--env-file=/dev/null",
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(raw);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return (block?.results ?? []) as Array<Record<string, unknown>>;
}

function ensureMigrations(): void {
  execSync("npx wrangler d1 migrations apply RECEIPTS_DB --local", {
    encoding: "utf8",
    stdio: "ignore",
  });
}

test(
  "revision flow: rev-2 create+finalize leaves rev-1 byte-identical",
  { skip: !RUN },
  () => {
  ensureMigrations();
  d1(`DELETE FROM receipt_exports WHERE export_month = '${TEST_MONTH}';`);

  // Seed a finalized revision-1 (the sealed June-1 analog), with a proofs zip.
  d1(
    `INSERT INTO receipt_exports
       (id, export_month, status, archive_r2_key, manifest_r2_key, archive_sha256,
        manifest_sha256, proofs_r2_key, proofs_sha256, bundle_built_at,
        created_by, created_at, finalized_at, finalized_by, export_revision)
     VALUES
       ('rev1', '${TEST_MONTH}', 'finalized', 'k-archive', 'k-manifest', 'sha-archive',
        'sha-manifest', 'k-proofs', 'sha-proofs', '2026-07-01T00:00:00Z',
        'op', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'op', 1);`,
  );

  // Snapshot rev-1 exactly as sealed.
  const before = d1(`SELECT * FROM receipt_exports WHERE id = 'rev1';`)[0]!;
  assert.equal(before.status, "finalized");
  assert.equal(before.proofs_r2_key, "k-proofs");

  // createExportRevision: insert a revision-2 draft that supersedes rev-1.
  d1(
    `INSERT INTO receipt_exports
       (id, export_month, status, created_by, created_at,
        export_revision, supersedes_export_id, correction_reason,
        retention_until, legal_hold)
     VALUES
       ('rev2', '${TEST_MONTH}', 'draft', 'op', '2026-07-02T00:00:00Z',
        2, 'rev1', '様式移行: 証憑ZIP・No列・お知らせ追加',
        '2031-07-02T00:00:00Z', 1);`,
  );

  // finalizeExport: flip ONLY the rev-2 row (WHERE id = ? AND status = 'draft').
  d1(
    `UPDATE receipt_exports
       SET status = 'finalized', finalized_at = '2026-07-02T00:00:00Z', finalized_by = 'op'
     WHERE id = 'rev2' AND status = 'draft';`,
  );

  // rev-1 must be byte-identical — no column touched by the revision flow.
  const after = d1(`SELECT * FROM receipt_exports WHERE id = 'rev1';`)[0]!;
  assert.deepEqual(after, before, "rev-1 must be unchanged after rev-2 create+finalize");

  // rev-2 finalized, carrying revision context.
  const rev2 = d1(
    `SELECT status, export_revision, supersedes_export_id, correction_reason
     FROM receipt_exports WHERE id = 'rev2';`,
  )[0]!;
  assert.equal(rev2.status, "finalized");
  assert.equal(rev2.export_revision, 2);
  assert.equal(rev2.supersedes_export_id, "rev1");
  assert.equal(rev2.correction_reason, "様式移行: 証憑ZIP・No列・お知らせ追加");

  // getExport picks the highest revision (rev-2 over rev-1) — the row the
  // operator sees + the finalize-only route acts on.
  const latest = d1(
    `SELECT id FROM receipt_exports WHERE export_month = '${TEST_MONTH}'
     ORDER BY COALESCE(export_revision, 1) DESC, created_at DESC LIMIT 1;`,
  )[0]!;
  assert.equal(latest.id, "rev2", "getExport ordering must pick revision 2");

  d1(`DELETE FROM receipt_exports WHERE export_month = '${TEST_MONTH}';`);
});
