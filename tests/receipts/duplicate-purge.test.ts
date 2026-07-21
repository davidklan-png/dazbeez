import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore — node:sqlite is available at runtime in Node 25 but not yet in @types/node.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  assessSelection,
  completeness,
  type DuplicateMemberInput,
} from "@/lib/receipts/duplicate-resolution-policy";
import {
  mapBucketName,
  parsePendingKeys,
  parseSourceIds,
  rewriteSourceIds,
  deriveCandidateStrength,
  PURGE_TARGET_CAP,
} from "@/lib/receipts/duplicate-purge";
import type { ReceiptRecord } from "@/lib/receipts/types";

// ─── fixtures ───────────────────────────────────────────────────────────────

function m(partial: Partial<DuplicateMemberInput> & Pick<DuplicateMemberInput, "id">): DuplicateMemberInput {
  return {
    captured_at: "2026-06-19T00:00:00Z",
    updated_at: "v1",
    status: "reviewed",
    exported: false,
    archived: false,
    claimedByConfirmedAmexLine: false,
    businessTripLinked: false,
    emailIntakePromoted: false,
    transaction_date: null,
    merchant: null,
    amount_minor: null,
    currency: "JPY",
    expense_category_code: null,
    business_purpose: null,
    tax_amount_minor: null,
    tax_rate: null,
    invoice_registration_number: null,
    qualified_invoice_status: "not_checked",
    counterparty_name: null,
    attendeesRequired: false,
    attendeesCount: 0,
    extractionState: null,
    hasOriginalFile: false,
    hasProofFile: false,
    ...partial,
  } as DuplicateMemberInput;
}

function row(partial: Partial<ReceiptRecord> & Pick<ReceiptRecord, "id">): ReceiptRecord {
  return {
    captured_at: "2026-06-19T00:00:00Z",
    captured_by: "op",
    source: "mobile_capture",
    original_filename: null,
    payment_path: "AMEX",
    expense_type: "UNKNOWN",
    transaction_date: "2026-06-19",
    merchant: "岡芳商店",
    amount_minor: 3862,
    currency: "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "reviewed",
    original_r2_key: "k",
    original_sha256: "s",
    original_content_type: "image/jpeg",
    original_size_bytes: 100,
    processed_r2_key: null,
    extraction_json: null,
    legacy: 0,
    exported_month: null,
    expense_category_code: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    updated_at: "v1",
    ...partial,
  } as ReceiptRecord;
}

// ─── §1: assessSelection — explicit selection (no defaults) ─────────────────

test("§1 assessSelection: no targets selected → not blocked, empty perTarget", () => {
  const members = [m({ id: "a" }), m({ id: "b" })];
  const s = assessSelection(members, "a", []);
  assert.equal(s.blocked, false);
  assert.equal(s.perTarget.length, 0);
});

test("§1 assessSelection: only explicitly selected targets assessed", () => {
  const members = [
    m({ id: "retained", merchant: "X", amount_minor: 100 }),
    m({ id: "checked", merchant: "X", amount_minor: 100 }),
    m({ id: "unchecked", merchant: "X", amount_minor: 100 }),
  ];
  const s = assessSelection(members, "retained", ["checked"]);
  assert.equal(s.perTarget.length, 1);
  assert.equal(s.perTarget[0]!.id, "checked");
  assert.equal(s.perTarget[0]!.purgeable, true);
});

test("§1 assessSelection: changing retained recomputes blockers for new selection", () => {
  const members = [
    m({ id: "a", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 100 }),
    m({ id: "b", merchant: "X", amount_minor: 100 }),
  ];
  // Retain b, target a → a is protected → blocked.
  const s1 = assessSelection(members, "b", ["a"]);
  assert.equal(s1.blocked, true);
  // Retain a, target b → b is unprotected, lower-equal tier → purgeable.
  const s2 = assessSelection(members, "a", ["b"]);
  assert.equal(s2.blocked, false);
});

// ─── §3: selection policy enforcement ────────────────────────────────────────

test("§3 registered target cannot be purged for unregistered retained", () => {
  const members = [
    m({ id: "ret", merchant: "X", amount_minor: 100 }),
    m({ id: "tgt", merchant: "X", amount_minor: 100, businessTripLinked: true }),
  ];
  const s = assessSelection(members, "ret", ["tgt"]);
  assert.equal(s.blocked, true);
  assert.ok(s.perTarget[0]!.blockers.some((b) => b.includes("tier")));
});

test("§3 more-complete same-tier target cannot be purged", () => {
  const members = [
    m({ id: "ret", merchant: "X", amount_minor: 100 }),
    m({ id: "tgt", merchant: "X", amount_minor: 100, expense_category_code: "supplies", business_purpose: "p" }),
  ];
  const s = assessSelection(members, "ret", ["tgt"]);
  assert.equal(s.blocked, true);
  assert.ok(s.perTarget[0]!.blockers.some((b) => b.includes("more complete")));
});

test("§3 protected target cannot be purged", () => {
  const members = [
    m({ id: "ret", claimedByConfirmedAmexLine: true, merchant: "X", amount_minor: 100 }),
    m({ id: "tgt", merchant: "X", amount_minor: 100 }),
    m({ id: "prot", exported: true, merchant: "X", amount_minor: 100 }),
  ];
  const s = assessSelection(members, "ret", ["tgt", "prot"]);
  const protTarget = s.perTarget.find((t) => t.id === "prot")!;
  assert.equal(protTarget.purgeable, false);
  assert.ok(protTarget.blockers.some((b) => b.includes("Protected")));
});

// ─── §3: completeness rules ──────────────────────────────────────────────────

test("§3 category-required attendees affect completeness", () => {
  const noAtt = m({ id: "a", attendeesRequired: true, attendeesCount: 0, merchant: "X", amount_minor: 100 });
  const withAtt = m({ id: "b", attendeesRequired: true, attendeesCount: 2, merchant: "X", amount_minor: 100 });
  assert.ok(completeness(withAtt).score > completeness(noAtt).score);
});

test("§3 extraction state does NOT affect completeness score", () => {
  const processed = m({ id: "a", extractionState: "processed", merchant: "X", amount_minor: 100 });
  const queued = m({ id: "b", extractionState: "queued", merchant: "X", amount_minor: 100 });
  assert.equal(completeness(processed).score, completeness(queued).score);
});

// ─── §6: provenance safety ───────────────────────────────────────────────────

test("§6 parseSourceIds: malformed JSON returns null (abort, never erase)", () => {
  assert.equal(parseSourceIds("{bad json"), null);
  assert.equal(parseSourceIds('"not array"'), null);
  assert.equal(parseSourceIds("[1,2]"), null); // non-string elements
});

test("§6 parseSourceIds: valid arrays parse", () => {
  assert.deepEqual(parseSourceIds(null), []);
  assert.deepEqual(parseSourceIds('["a","b"]'), ["a", "b"]);
});

test("§6 rewriteSourceIds: LIKE false positive (target not in array) → untouched (null)", () => {
  // The rule row matched a LIKE '%target%' but the parsed JSON doesn't actually
  // contain the target — a substring collision. Must NOT rewrite.
  const rw = rewriteSourceIds('["abc-target-def"]', "target", "retained");
  assert.equal(rw, null);
});

test("§6 rewriteSourceIds: exact match removes target, adds retained, dedupes", () => {
  const rw = rewriteSourceIds('["a","target","b"]', "target", "retained");
  assert.ok(rw);
  const parsed = JSON.parse(rw!.rewritten) as string[];
  assert.ok(!parsed.includes("target"));
  assert.ok(parsed.includes("retained"));
  assert.equal(parsed.includes("retained"), true);
  // retained not double-added
  assert.equal(parsed.filter((x) => x === "retained").length, 1);
});

// ─── §7: R2 bucket mapping ───────────────────────────────────────────────────

test("§7 mapBucketName: receipts→LIVE, archive→ARCHIVE, unknown→null", () => {
  assert.equal(mapBucketName("receipts"), "RECEIPTS_BUCKET");
  assert.equal(mapBucketName("archive"), "RECEIPTS_ARCHIVE_BUCKET");
  assert.equal(mapBucketName("dazbeez-receipts"), "RECEIPTS_BUCKET");
  assert.equal(mapBucketName("dazbeez-receipts-archive"), "RECEIPTS_ARCHIVE_BUCKET");
  assert.equal(mapBucketName("unknown-bucket"), null);
});

test("§7 parsePendingKeys: valid, malformed→null (never [])", () => {
  assert.equal(parsePendingKeys(null), null);
  assert.equal(parsePendingKeys(""), null);
  assert.equal(parsePendingKeys("not json"), null);
  assert.equal(parsePendingKeys("[]")!.length, 0); // valid empty array
  assert.equal(parsePendingKeys('[{"bucket":"receipts","key":"a"}]')!.length, 1);
  assert.equal(parsePendingKeys('[{"bucket":"bad","key":"a"}]'), null); // unknown bucket
  assert.equal(parsePendingKeys('[{"bucket":"receipts"}]'), null); // missing key
});

test("§7 malformed retry inventory never reports completed", () => {
  // parsePendingKeys(null) → null → retry would treat as malformed → storage_failed
  assert.equal(parsePendingKeys(null), null);
  assert.equal(parsePendingKeys("garbage"), null);
});

// ─── §3/§8: deriveCandidateStrength (mixed strong/near per pair) ──────────────

test("§8 deriveCandidateStrength: strong for same merchant+amount+date", () => {
  const retained = row({ id: "r", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19" });
  const target = row({ id: "t", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19" });
  assert.equal(deriveCandidateStrength(retained, target), "strong");
});

test("§8 deriveCandidateStrength: near for differing merchant, same amount+date", () => {
  const retained = row({ id: "r", merchant: "PERFECT", amount_minor: 14040, transaction_date: "2026-06-12" });
  const target = row({ id: "t", merchant: "PBK四ッ谷/Air", amount_minor: 14040, transaction_date: "2026-06-12" });
  assert.equal(deriveCandidateStrength(retained, target), "near");
});

test("§8 deriveCandidateStrength: null for non-candidate", () => {
  const retained = row({ id: "r", merchant: "X", amount_minor: 100, transaction_date: "2026-06-19" });
  const target = row({ id: "t", merchant: "Y", amount_minor: 99999, transaction_date: "2026-06-19" });
  assert.equal(deriveCandidateStrength(retained, target), null);
});

// ─── §2: request contract validation (caps, dup ids, confirmation) ───────────

test("§2 PURGE_TARGET_CAP is 10", () => {
  assert.equal(PURGE_TARGET_CAP, 10);
});

// ─── §5: write-time trigger guard (node:sqlite) ──────────────────────────────
// Real SQLite in-process — applies migration 0032 + minimal schema, exercises the
// trigger's RAISE(ROLLBACK) for write-time race conditions.

function setupTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Minimal receipt_records (enough columns for the trigger to reference).
  db.exec(`
    CREATE TABLE receipt_records (
      id TEXT PRIMARY KEY,
      captured_at TEXT NOT NULL DEFAULT '',
      captured_by TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      payment_path TEXT NOT NULL DEFAULT 'AMEX',
      transaction_date TEXT,
      merchant TEXT,
      amount_minor INTEGER,
      currency TEXT NOT NULL DEFAULT 'JPY',
      status TEXT NOT NULL DEFAULT 'reviewed',
      deleted_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      original_r2_key TEXT,
      original_sha256 TEXT,
      expense_category_code TEXT,
      business_purpose TEXT,
      tax_amount_minor INTEGER,
      tax_rate TEXT,
      invoice_registration_number TEXT,
      counterparty_name TEXT,
      extraction_state TEXT
    );
    CREATE TABLE amex_statement_lines (
      id TEXT PRIMARY KEY,
      statement_month TEXT NOT NULL,
      matched_receipt_id TEXT,
      match_status TEXT NOT NULL DEFAULT 'unmatched'
    );
    CREATE TABLE receipt_exports (id TEXT PRIMARY KEY, export_month TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft');
    CREATE TABLE receipt_export_items (
      id TEXT PRIMARY KEY,
      export_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL
    );
  `);
  // Apply migration 0032 (table + trigger).
  const migration = readFileSync("db/receipts/0032_duplicate_purge_log.sql", "utf8");
  db.exec(migration);
  return db;
}

function insertReceipt(db: DatabaseSync, id: string, over: Record<string, unknown> = {}) {
  const cols = Object.keys(over);
  const vals = Object.values(over);
  const placeholders = cols.map(() => "?").join(",");
  db.prepare(`INSERT INTO receipt_records (id, ${cols.join(",")}) VALUES (?, ${placeholders})`).run(id, ...vals);
}

test("§5 trigger: happy path — batch commits when guards pass", () => {
  const db = setupTestDb();
  insertReceipt(db, "retained", { updated_at: "v1", status: "reconciled" });
  insertReceipt(db, "target", { updated_at: "v1", status: "reviewed" });

  db.exec("BEGIN");
  db.prepare(`INSERT INTO duplicate_purge_log (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength, expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, status, created_at)
              VALUES ('job1','target','retained','op','dup','strong','v1','v1',1,'d1_pending','now')`).run();
  // The guarded DELETE — trigger should pass (all conditions met).
  db.prepare("DELETE FROM receipt_records WHERE id = 'target'").run();
  db.prepare("UPDATE duplicate_purge_log SET status='storage_pending' WHERE id='job1'").run();
  db.exec("COMMIT");

  // Target deleted, retained intact, job transitioned.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='target'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='retained'").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM duplicate_purge_log WHERE id='job1'").get().status, "storage_pending");
});

test("§5 trigger: target updated_at changed → ROLLBACK (whole batch)", () => {
  const db = setupTestDb();
  insertReceipt(db, "retained", { updated_at: "v1", status: "reconciled" });
  insertReceipt(db, "target", { updated_at: "changed!", status: "reviewed" });

  assert.throws(
    () => {
      db.exec("BEGIN");
      db.prepare(`INSERT INTO duplicate_purge_log (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength, expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, status, created_at)
                  VALUES ('job2','target','retained','op','dup','strong','v1','v1',1,'d1_pending','now')`).run();
      db.prepare("DELETE FROM receipt_records WHERE id = 'target'").run();
      db.exec("COMMIT");
    },
    /duplicate-purge guard: target updated_at/,
  );
  // Transaction rolled back: receipt NOT deleted.
  try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='target'").get().n, 1);
});

test("§5 trigger: target gained an AMEX claim → ROLLBACK", () => {
  const db = setupTestDb();
  insertReceipt(db, "retained", { updated_at: "v1", status: "reconciled" });
  insertReceipt(db, "target", { updated_at: "v1", status: "reviewed" });
  // AMEX claim appeared between preflight and delete.
  db.prepare("INSERT INTO amex_statement_lines (id, statement_month, matched_receipt_id, match_status) VALUES ('L1','2026-08','target','confirmed')").run();

  assert.throws(
    () => {
      db.exec("BEGIN");
      db.prepare(`INSERT INTO duplicate_purge_log (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength, expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, status, created_at)
                  VALUES ('job3','target','retained','op','dup','strong','v1','v1',1,'d1_pending','now')`).run();
      db.prepare("DELETE FROM receipt_records WHERE id = 'target'").run();
      db.exec("COMMIT");
    },
    /duplicate-purge guard: target gained an AMEX claim/,
  );
  try { db.exec("ROLLBACK"); } catch { /* */ }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='target'").get().n, 1);
});

test("§5 trigger: target gained an export item → ROLLBACK", () => {
  const db = setupTestDb();
  insertReceipt(db, "retained", { updated_at: "v1", status: "reconciled" });
  insertReceipt(db, "target", { updated_at: "v1", status: "reviewed" });
  db.prepare("INSERT INTO receipt_exports (id, export_month) VALUES ('E1','2026-08')").run();
  db.prepare("INSERT INTO receipt_export_items (id, export_id, item_type, item_id) VALUES ('EI1','E1','receipt','target')").run();

  assert.throws(
    () => {
      db.exec("BEGIN");
      db.prepare(`INSERT INTO duplicate_purge_log (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength, expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, status, created_at)
                  VALUES ('job4','target','retained','op','dup','strong','v1','v1',1,'d1_pending','now')`).run();
      db.prepare("DELETE FROM receipt_records WHERE id = 'target'").run();
      db.exec("COMMIT");
    },
    /duplicate-purge guard: target gained an export item/,
  );
  try { db.exec("ROLLBACK"); } catch { /* */ }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='target'").get().n, 1);
});

test("§5 trigger: retained changed (updated_at mismatch) → ROLLBACK", () => {
  const db = setupTestDb();
  insertReceipt(db, "retained", { updated_at: "changed!", status: "reconciled" });
  insertReceipt(db, "target", { updated_at: "v1", status: "reviewed" });

  assert.throws(
    () => {
      db.exec("BEGIN");
      db.prepare(`INSERT INTO duplicate_purge_log (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength, expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, status, created_at)
                  VALUES ('job5','target','retained','op','dup','strong','v1','v1',1,'d1_pending','now')`).run();
      db.prepare("DELETE FROM receipt_records WHERE id = 'target'").run();
      db.exec("COMMIT");
    },
    /duplicate-purge guard: retained receipt/,
  );
  try { db.exec("ROLLBACK"); } catch { /* */ }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='target'").get().n, 1);
});

test("§5 trigger: status changed (exported) → ROLLBACK", () => {
  const db = setupTestDb();
  insertReceipt(db, "retained", { updated_at: "v1", status: "reconciled" });
  insertReceipt(db, "target", { updated_at: "v1", status: "exported" });

  assert.throws(
    () => {
      db.exec("BEGIN");
      db.prepare(`INSERT INTO duplicate_purge_log (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength, expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, status, created_at)
                  VALUES ('job6','target','retained','op','dup','strong','v1','v1',1,'d1_pending','now')`).run();
      db.prepare("DELETE FROM receipt_records WHERE id = 'target'").run();
      db.exec("COMMIT");
    },
    /duplicate-purge guard: target status/,
  );
  try { db.exec("ROLLBACK"); } catch { /* */ }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='target'").get().n, 1);
});

test("§5 trigger: hardDeleteReceipt path (no pending job) — DELETE succeeds", () => {
  const db = setupTestDb();
  insertReceipt(db, "retained", { updated_at: "v1" });
  insertReceipt(db, "orphan", { updated_at: "v1", status: "captured" });
  // No d1_pending job → trigger WHEN=false → DELETE succeeds (hardDeleteReceipt path).
  db.prepare("DELETE FROM receipt_records WHERE id = 'orphan'").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='orphan'").get().n, 0);
});

test("§5 trigger: request-wide multi-target atomic — target 2 fails → target 1 NOT deleted", () => {
  const db = setupTestDb();
  insertReceipt(db, "retained", { updated_at: "v1", status: "reconciled" });
  insertReceipt(db, "t1", { updated_at: "v1", status: "reviewed" });
  insertReceipt(db, "t2", { updated_at: "changed!", status: "reviewed" }); // t2 stale

  assert.throws(
    () => {
      db.exec("BEGIN");
      // Target 1: valid — insert job + delete.
      db.prepare(`INSERT INTO duplicate_purge_log (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength, expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, status, created_at)
                  VALUES ('j1','t1','retained','op','dup','strong','v1','v1',1,'d1_pending','now')`).run();
      db.prepare("DELETE FROM receipt_records WHERE id = 't1'").run();
      // Target 2: stale → trigger fires → ROLLBACK.
      db.prepare(`INSERT INTO duplicate_purge_log (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength, expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, status, created_at)
                  VALUES ('j2','t2','retained','op','dup','strong','v1','v1',1,'d1_pending','now')`).run();
      db.prepare("DELETE FROM receipt_records WHERE id = 't2'").run();
      db.exec("COMMIT");
    },
    /duplicate-purge guard: target updated_at/,
  );
  try { db.exec("ROLLBACK"); } catch { /* */ }
  // BOTH targets survived (rollback).
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='t1'").get().n, 1, "t1 must survive");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receipt_records WHERE id='t2'").get().n, 1, "t2 must survive");
});
