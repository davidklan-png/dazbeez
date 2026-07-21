import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error node:sqlite is present in the project test runtime.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE receipt_records (
      id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, deleted_at TEXT,
      payment_path TEXT NOT NULL, status TEXT NOT NULL, exported_month TEXT,
      extraction_state TEXT
    );
    CREATE TABLE receipt_attendees (
      id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, attendee_name TEXT NOT NULL,
      company TEXT, relationship TEXT, is_dazbeez_employee INTEGER NOT NULL DEFAULT 0,
      notes TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE amex_statement_lines (
      id TEXT PRIMARY KEY, statement_month TEXT NOT NULL, matched_receipt_id TEXT, match_status TEXT
    );
    CREATE TABLE amex_reconciliations (id TEXT PRIMARY KEY, statement_month TEXT, status TEXT);
    CREATE TABLE receipt_exports (
      id TEXT PRIMARY KEY, export_month TEXT, status TEXT, export_revision INTEGER,
      correction_reason TEXT
    );
    CREATE TABLE receipt_export_items (id TEXT PRIMARY KEY, export_id TEXT, item_type TEXT, item_id TEXT);
    CREATE TABLE receipt_audit_log (id TEXT PRIMARY KEY, action TEXT);
  `);
  db.exec(readFileSync("db/receipts/0033_duplicate_merge_log.sql", "utf8"));
  db.prepare("INSERT INTO receipt_records VALUES (?,?,?,?,?,NULL,'processed')").run("retained", "rv1", null, "AMEX", "reviewed");
  db.prepare("INSERT INTO receipt_records VALUES (?,?,?,?,?,NULL,'processed')").run("source", "sv1", null, "AMEX", "reviewed");
  return db;
}

const insertMerge = `INSERT INTO duplicate_merge_log
  (id,retained_receipt_id,retained_expected_updated_at,retained_attendees_json,
   source_snapshots_json,actor,resolution_plan_json,old_value_json,new_value_json,
   candidate_strengths_json,created_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

function args(sourceVersion = "sv1") {
  return [
    "merge-1", "retained", "rv1", "[]",
    JSON.stringify([{ id: "source", updatedAt: sourceVersion, attendees: [] }]),
    "operator", "[]", "{}", "{}", '{"source":"strong"}', "now",
  ];
}

test("0033 trigger accepts unchanged AMEX snapshots", () => {
  const db = setup();
  db.prepare(insertMerge).run(...args());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM duplicate_merge_log").get().n, 1);
});

test("0033 trigger rejects a stale source before retained mutation", () => {
  const db = setup();
  assert.throws(() => db.prepare(insertMerge).run(...args("old")), /source missing, changed, or protected/i);
  assert.equal(db.prepare("SELECT updated_at FROM receipt_records WHERE id='retained'").get().updated_at, "rv1");
});

test("0033 trigger rejects a source that returned to pending extraction", () => {
  const db = setup();
  db.prepare("UPDATE receipt_records SET extraction_state='queued' WHERE id='source'").run();
  assert.throws(() => db.prepare(insertMerge).run(...args()), /source missing, changed, or protected/i);
});

test("0033 trigger rejects changed attendee metadata, not only changed names", () => {
  const db = setup();
  db.prepare("INSERT INTO receipt_attendees VALUES ('a1','source','Bob','Client','client',0,'Host','now')").run();
  const staleSnapshot = [{
    id: "source", updatedAt: "sv1", attendees: [{
      id: "a1", attendeeName: "Bob", company: "Client", relationship: "client",
      isDazbeezEmployee: 0, notes: "different", createdAt: "now",
    }],
  }];
  const values = args();
  values[4] = JSON.stringify(staleSnapshot);
  assert.throws(() => db.prepare(insertMerge).run(...values), /source attendee set changed/i);
});

test("merge transaction rolls back log and retained update when a later audit statement fails", () => {
  const db = setup();
  db.prepare("INSERT INTO receipt_audit_log VALUES ('audit-1','existing')").run();
  assert.throws(() => {
    db.exec("BEGIN");
    db.prepare(insertMerge).run(...args());
    db.prepare("UPDATE receipt_records SET updated_at='rv2' WHERE id='retained'").run();
    db.prepare("INSERT INTO receipt_audit_log VALUES ('audit-1','duplicate')").run();
    db.exec("COMMIT");
  }, /UNIQUE/i);
  try { db.exec("ROLLBACK"); } catch { /* SQLite RAISE/constraint may already close it. */ }
  assert.equal(db.prepare("SELECT updated_at FROM receipt_records WHERE id='retained'").get().updated_at, "rv1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM duplicate_merge_log").get().n, 0);
});
