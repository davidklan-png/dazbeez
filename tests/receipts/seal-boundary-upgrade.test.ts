// Seal boundary round 2 — the UPGRADE path regression (follow-up PR).
//
// 0042 shipped in PR #208 (round-1 trigger matrix) is frozen: wrangler's d1
// migrations ledger has it applied on production (verified read-only), so the
// round-2 guards ship as the FORWARD migration 0043, which retires the 0042
// matrix and installs the complete round-2 one. These tests prove:
//
//   1. the round-1 state (every migration through 0042, 0043 excluded) really
//      exhibits the reviewed defects;
//   2. applying 0043 to that state upgrades every B2–B7/B10 guard in place;
//   3. a FRESH database (all migrations incl. 0043) is byte-identical to the
//      upgraded one, trigger-for-trigger;
//   4. 0043 is idempotent (safe to re-run).
//
// The full guard matrix on the final schema is exercised by
// seal-boundary-migration.test.ts (which applies every migration file in
// order — on this branch that is round-1 0042 + 0043).

import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error node:sqlite is present in the project test runtime.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

type RawDb = ReturnType<typeof mkRaw>;

function mkRaw(): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return db as unknown as InstanceType<typeof DatabaseSync>;
}

function applyMigrations(db: RawDb, throughInclusive?: string, skip?: string): void {
  const files = readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (skip && f === skip) continue;
    db.exec(readFileSync(`db/receipts/${f}`, "utf8"));
    if (throughInclusive && f.startsWith(throughInclusive)) break;
  }
}

/** Run a statement; on a seal trigger rejection return its stable identifier. */
function R(db: RawDb, sql: string, ...p: unknown[]): true | string {
  try {
    db.prepare(sql).run(...p);
    return true;
  } catch (e) {
    const m = /DZ_SEAL_[A-Z_]+/.exec((e as Error).message);
    return m ? m[0] : `OTHER: ${(e as Error).message.slice(0, 60)}`;
  }
}

const now = () => Math.floor(Date.now() / 1000);

function seedFixture(db: RawDb): void {
  // A sealed month (2026-06): finalized export with a shipped CASH receipt,
  // plus an unmatched AMEX receipt and a claimed month (2026-07) for the
  // negative-scope checks.
  db.prepare(
    `INSERT INTO receipt_records
       (id,captured_at,captured_by,payment_path,transaction_date,merchant,amount_minor,
        currency,status,original_r2_key,original_sha256,original_content_type,
        original_size_bytes,created_at,updated_at,export_statement_month)
     VALUES ('r6','t','a','CASH','2026-06-10','m',100,'JPY','reviewed','k','s','image/jpeg',1,'t','t','2026-06')`,
  ).run();
  db.prepare(
    `INSERT INTO receipt_records
       (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,
        original_sha256,original_content_type,original_size_bytes,created_at,updated_at)
     VALUES ('amex','t','a','AMEX','2026-06-11','captured','ka','s','image/jpeg',1,'t','t')`,
  ).run();
  db.prepare(
    `INSERT INTO receipt_records
       (id,captured_at,captured_by,payment_path,transaction_date,merchant,amount_minor,
        currency,status,original_r2_key,original_sha256,original_content_type,
        original_size_bytes,created_at,updated_at,export_statement_month)
     VALUES ('r7','t','a','CASH','2026-07-10','m',100,'JPY','reviewed','k7','s','image/jpeg',1,'t','t','2026-07')`,
  ).run();
  db.prepare(`INSERT INTO receipt_exports (id,export_month,status,created_by,created_at,retention_until,legal_hold) VALUES ('e6','2026-06','draft','a','t','t',1)`).run();
  db.prepare(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i6','e6','receipt','r6','t')`).run();
  db.prepare(`INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('at6','r6','before','t')`).run();
  db.prepare(`UPDATE receipt_exports SET status='finalized' WHERE id='e6'`).run();
  db.prepare(
    `INSERT INTO receipt_exports (id,export_month,status,created_by,created_at,retention_until,legal_hold,export_revision,sealing_token,sealing_expires_at)
     VALUES ('e7','2026-07','draft','a','t','t',1,1,'tok',?)`,
  ).run(now() + 600);
}

function db_exec(db: RawDb, file: string): void {
  db.exec(readFileSync(file, "utf8"));
}

/** A build claim on the SEALED month's own calendar month (a correction-draft
 *  rebuild) — what over-fenced the unmatched AMEX receipt on round-1 bodies. */
function addSealedMonthClaim(db: RawDb): void {
  db.prepare(
    `INSERT INTO receipt_exports (id,export_month,status,created_by,created_at,retention_until,legal_hold,export_revision,sealing_token,sealing_expires_at)
     VALUES ('e6d','2026-06','draft','a','t','t',1,2,'tok6',?)`,
  ).run(now() + 600);
}

test("UPGRADE the round-1 schema (all migrations through 0042) exhibits the reviewed defects", () => {
  const db = mkRaw();
  applyMigrations(db, "0042", "0043_seal_boundary_round2.sql");
  seedFixture(db);
  // B3: sealed attendee UPDATE committed on round-1 bodies.
  assert.equal(R(db, `UPDATE receipt_attendees SET attendee_name='after' WHERE id='at6'`), true, "round-1 defect: sealed attendee rename allowed");
  // B2: OLD-scope escape allowed on round-1 bodies.
  assert.equal(
    R(db, `UPDATE receipt_records SET payment_path='AMEX', transaction_date=NULL, export_statement_month=NULL, amount_minor=999 WHERE id='r6'`),
    true,
    "round-1 defect: OLD-month escape allowed",
  );
  // B5: independent finalized item DELETE allowed on round-1 bodies.
  assert.equal(R(db, `DELETE FROM receipt_export_items WHERE id='i6'`), true, "round-1 defect: finalized item delete allowed");
  // B10: unmatched AMEX over-fenced on round-1 bodies (claim on its own
  // calendar month via a correction-draft rebuild; separate DB so the active
  // claim does not mask the post-seal probes above).
  {
    const d2 = mkRaw();
    applyMigrations(d2, "0042", "0043_seal_boundary_round2.sql");
    seedFixture(d2);
    addSealedMonthClaim(d2);
    assert.equal(R(d2, `UPDATE receipt_records SET amount_minor=200 WHERE id='amex'`), "DZ_SEAL_CLAIM_ACTIVE", "round-1 defect: unrelated unmatched AMEX fenced");
  }
});

test("UPGRADE applying 0043 to the round-1 database installs every round-2 guard", () => {
  const db = mkRaw();
  applyMigrations(db, "0042", "0043_seal_boundary_round2.sql");
  seedFixture(db);
  db.exec(readFileSync("db/receipts/0043_seal_boundary_round2.sql", "utf8"));

  // B3: attendee rename now refused (and reparenting is covered by the main suite).
  assert.equal(R(db, `UPDATE receipt_attendees SET attendee_name='after' WHERE id='at6'`), "DZ_SEAL_MONTH_LOCKED");
  // B2: OLD-scope escape refused; item-derived lock holds (fixture ships r6).
  assert.equal(
    R(db, `UPDATE receipt_records SET payment_path='AMEX', transaction_date=NULL, export_statement_month=NULL, amount_minor=999 WHERE id='r6'`),
    "DZ_SEAL_MONTH_LOCKED",
  );
  // B5: independent finalized item DELETE refused; the marker path is covered
  // by the main suite.
  assert.equal(R(db, `DELETE FROM receipt_export_items WHERE id='i6'`), "DZ_SEAL_ITEMS_FROZEN");
  // B10: unmatched AMEX now editable under a claim on its own calendar month;
  // the claimed-month receipt stays fenced (separate DB, same reason).
  {
    const d2 = mkRaw();
    applyMigrations(d2, "0042", "0043_seal_boundary_round2.sql");
    seedFixture(d2);
    db_exec(d2, "db/receipts/0043_seal_boundary_round2.sql");
    addSealedMonthClaim(d2);
    assert.equal(R(d2, `UPDATE receipt_records SET amount_minor=200 WHERE id='amex'`), true, "upgraded: unmatched AMEX allowed");
    assert.equal(R(d2, `UPDATE receipt_records SET amount_minor=201 WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE", "upgraded: claimed-month receipt fenced");
  }
});

test("UPGRADE a FRESH database (all migrations incl. 0043) is trigger-for-trigger identical to the upgraded one", () => {
  const fresh = mkRaw();
  applyMigrations(fresh); // includes round-1 0042 then 0043
  const upgraded = mkRaw();
  applyMigrations(upgraded, "0042", "0043_seal_boundary_round2.sql");
  upgraded.exec(readFileSync("db/receipts/0043_seal_boundary_round2.sql", "utf8"));

  const q = `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'seal_%' ORDER BY name`;
  const a = (fresh.prepare(q).all() as unknown as { name: string; sql: string }[]);
  const b = (upgraded.prepare(q).all() as unknown as { name: string; sql: string }[]);
  assert.equal(a.length, 52, "round-2 matrix size");
  assert.deepEqual(
    a.map((r) => r.name),
    b.map((r) => r.name),
    "same trigger set",
  );
  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i]!.sql, b[i]!.sql, `trigger body identical: ${a[i]!.name}`);
  }
});

test("UPGRADE 0043 is idempotent (safe to re-run)", () => {
  const db = mkRaw();
  applyMigrations(db);
  db.exec(readFileSync("db/receipts/0043_seal_boundary_round2.sql", "utf8"));
  db.exec(readFileSync("db/receipts/0043_seal_boundary_round2.sql", "utf8"));
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'seal_%'`).get() as unknown as { n: number }).n;
  assert.equal(n, 52, "no duplicated triggers after a double run");
});
