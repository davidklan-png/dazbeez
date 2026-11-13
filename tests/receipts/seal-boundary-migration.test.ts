// Seal boundary (migration 0042) — the trigger matrix, executed against REAL
// SQLite with the FULL migration chain applied (every table, every prior
// trigger, FK cascades on). These exercise the SQL authority itself: a write
// that passed JS prechecks still cannot mutate an input fenced by an active
// build claim or a published seal. Contract: .polly/contracts/
// receipts-seal-boundary.md §B + regression acceptance 2–5.
import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error node:sqlite is present in the project test runtime.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

function mk(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`db/receipts/${f}`, "utf8"));
  }
  return db;
}

/** Run a statement; on trigger rejection return the DZ_SEAL_* identifier. */
function R(db: DatabaseSync, sql: string, ...p: unknown[]): true | string {
  try {
    db.prepare(sql).run(...p);
    return true;
  } catch (e) {
    // NB: node:sqlite truncates the RAISE message at the first ':' (driver
    // artifact — D1 preserves "DZ_SEAL_X:table"), so tests assert the stable
    // ASCII identifier only; which table was fenced is pinned by the statement.
    const m = /DZ_SEAL_[A-Z_]+/.exec((e as Error).message);
    return m ? m[0] : `OTHER: ${(e as Error).message.slice(0, 60)}`;
  }
}

function seedReceipt(
  db: DatabaseSync,
  id: string,
  mon: string,
  path = "CASH",
  over: Record<string, unknown> = {},
): void {
  db.prepare(
    `INSERT INTO receipt_records
       (id,captured_at,captured_by,payment_path,transaction_date,merchant,amount_minor,
        currency,status,original_r2_key,original_sha256,original_content_type,
        original_size_bytes,created_at,updated_at,export_statement_month)
     VALUES (?,'t','a',?,?,'m',100,'JPY','reviewed',?, 's','image/jpeg',1,'t','t',?)`,
  ).run(id, path, mon + "-10", "k" + id, mon);
  for (const [col, val] of Object.entries(over)) {
    db.prepare(`UPDATE receipt_records SET ${col} = ? WHERE id = ?`).run(val, id);
  }
}

function seedExport(
  db: DatabaseSync,
  id: string,
  mon: string,
  status: "draft" | "finalized",
  token?: string,
  ttlSecondsFromNow?: number,
  rev = 1,
): void {
  db.prepare(
    `INSERT INTO receipt_exports
       (id,export_month,status,created_by,created_at,retention_until,legal_hold,
        export_revision,sealing_token,sealing_expires_at)
     VALUES (?,?,?,'a','t','t',1,?,?,?)`,
  ).run(id, mon, status, rev, token ?? null, ttlSecondsFromNow === undefined ? null : Math.floor(Date.now() / 1000) + ttlSecondsFromNow);
}

const now = () => Math.floor(Date.now() / 1000);

// ─── Acceptance 2: SQL authority denies edits JS prechecks already passed ───

test("A2 claim fences receipt payload edits while a build is claimed", () => {
  const db = mk();
  seedReceipt(db, "r7", "2026-07");
  seedExport(db, "e7", "2026-07", "draft", "tok", 600);
  assert.equal(R(db, `UPDATE receipt_records SET amount_minor=999 WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE");
  assert.equal(R(db, `UPDATE receipt_records SET expense_category_code='meal' WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE");
  assert.equal(R(db, `UPDATE receipt_records SET transaction_date='2026-07-02' WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE");
  assert.equal(R(db, `UPDATE receipt_records SET payment_path='DIGITAL' WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE");
  assert.equal(R(db, `UPDATE receipt_records SET status='reconciled' WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE");
  // Gate-relevant extraction_state is frozen under a claim.
  assert.equal(R(db, `UPDATE receipt_records SET extraction_state='processed' WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE");
  // Unrelated months stay fully editable.
  seedReceipt(db, "r8", "2026-08");
  assert.equal(R(db, `UPDATE receipt_records SET amount_minor=1 WHERE id='r8'`), true);
});

test("A2 claim fences attendees, directory, settings, artifacts, files, recon", () => {
  const db = mk();
  seedReceipt(db, "r7", "2026-07");
  seedExport(db, "e7", "2026-07", "draft", "tok", 600);
  assert.equal(
    R(db, `INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('at','r7','x','t')`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  // Global directory fence while ANY claim is live (conservative, contract §B).
  assert.equal(
    R(db, `INSERT INTO attendee_directory (id,name,company,title,created_at,updated_at) VALUES (999,'n','c','t','t','t')`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  assert.equal(
    R(db, `INSERT INTO receipt_settings (key,value,updated_at,updated_by) VALUES ('export_block_on_warnings','true','t','a')`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  // Unrelated settings keys stay writable under a claim.
  assert.equal(
    R(db, `INSERT INTO receipt_settings (key,value,updated_at,updated_by) VALUES ('zzz_probe','1','t','a')`),
    true,
  );
  assert.equal(
    R(db, `INSERT INTO amex_statement_artifacts (id,statement_month,r2_key,sha256_hash,file_size_bytes,uploaded_by,uploaded_at,created_at,updated_at,import_status) VALUES ('a1','2026-07','k1','h1',1,'u','t','t','t','uploaded')`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  assert.equal(
    R(db, `INSERT INTO receipt_files (id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,file_size_bytes,sha256_hash,uploaded_by,uploaded_at,is_original,created_at,updated_at) VALUES ('f1','receipt','r7','original','receipts','kf','f','image/jpeg',1,'h','u','t',1,'t','t')`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  assert.equal(
    R(db, `INSERT INTO amex_reconciliations (id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at) VALUES ('ar','2026-07','draft',0,0,0,'a','t')`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
});

// ─── Acceptance 3: OLD/NEW matrix — both directions ──────────────────────────

test("A3 moving a receipt OUT of and INTO a claimed month both fenced", () => {
  const db = mk();
  seedReceipt(db, "rin", "2026-06"); // in claimed month (seeded pre-claim)
  seedReceipt(db, "rout", "2026-08"); // outside
  seedExport(db, "e6", "2026-06", "draft", "tok", 600);
  // OUT of the claimed month (OLD in scope): silently shrinks the bundle.
  assert.equal(
    R(db, `UPDATE receipt_records SET export_statement_month='2026-08', transaction_date='2026-08-01' WHERE id='rin'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  // INTO the claimed month (NEW in scope): silently grows the bundle.
  assert.equal(
    R(db, `UPDATE receipt_records SET export_statement_month='2026-06', transaction_date='2026-06-01' WHERE id='rout'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  // Clearing membership/date on a claimed-month receipt.
  assert.equal(
    R(db, `UPDATE receipt_records SET export_statement_month=NULL WHERE id='rin'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
});

test("A3 CASH→UNKNOWN / re-dating in claimed month; UNKNOWN insertion in claimed month", () => {
  const db = mk();
  seedReceipt(db, "r6", "2026-06");
  // Pre-claim: an UNKNOWN, undated receipt (the extraction-backfill starting
  // state) — dated later, inside the claim.
  seedReceipt(db, "r6u", "2026-06", "UNKNOWN", { transaction_date: null, export_statement_month: null, status: "captured" });
  seedExport(db, "e6", "2026-06", "draft", "tok", 600);
  assert.equal(
    R(db, `UPDATE receipt_records SET payment_path='UNKNOWN' WHERE id='r6'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  // An UNKNOWN receipt ACQUIRING a date in the claimed month changes the gate.
  assert.equal(
    R(db, `UPDATE receipt_records SET transaction_date='2026-06-15' WHERE id='r6u'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  // Fresh UNKNOWN capture dated in the claimed month.
  assert.equal(
    R(db, `INSERT INTO receipt_records (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at) VALUES ('r9','t','a','UNKNOWN','2026-06-05','captured','k9','s','image/jpeg',1,'t','t')`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
});

test("A3 line month moves, child parent-ID changes, cross-month claims", () => {
  const db = mk();
  seedReceipt(db, "rM", "2026-06", "AMEX", { export_statement_month: null });
  seedReceipt(db, "rN", "2026-09", "AMEX", { export_statement_month: null });
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at) VALUES ('LN','2026-09','2026-09-01','m',1,'JPY','unmatched','{}','t')`).run();
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at) VALUES ('LO','2026-08','2026-08-01','m',1,'JPY','unmatched','{}','t')`).run();
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id) VALUES ('LM','2026-06','2026-06-01','m',1,'JPY','matched','{}','t','rM')`).run();
  db.prepare(`INSERT INTO amex_line_attendees (id,amex_statement_line_id,attendee_name,created_at,updated_at) VALUES ('la','LN','x','t','t')`).run();
  seedExport(db, "e6", "2026-06", "draft", "tok", 600); // claimed month M
  // Cross-month: a line in OPEN month N claiming a receipt fenced by M.
  assert.equal(
    R(db, `UPDATE amex_statement_lines SET matched_receipt_id='rM', match_status='confirmed' WHERE id='LN'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  // Line month move INTO the claimed month.
  assert.equal(
    R(db, `UPDATE amex_statement_lines SET statement_month='2026-06' WHERE id='LO'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  // Line attendee parent change into a claimed month's line.
  assert.equal(
    R(db, `UPDATE amex_line_attendees SET amex_statement_line_id='LM' WHERE id='la'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
});

// ─── Acceptance 4: lifecycle escape; promotion; archived terminal ────────────

test("A4 lifecycle escape (status+amount in one UPDATE) is fenced on a sealed month", () => {
  const db = mk();
  seedReceipt(db, "r6", "2026-06");
  seedExport(db, "e6", "2026-06", "finalized");
  assert.equal(
    R(db, `UPDATE receipt_records SET status='exported', amount_minor=999, exported_month='2026-06' WHERE id='r6'`),
    "DZ_SEAL_MONTH_LOCKED",
  );
  // Status-only promotion without item justification is also fenced.
  assert.equal(
    R(db, `UPDATE receipt_records SET status='exported', exported_month='2026-06' WHERE id='r6'`),
    "DZ_SEAL_MONTH_LOCKED",
  );
});

test("A4 exact exporter promotion succeeds; wrong month / payload drift fenced", () => {
  const db = mk();
  seedReceipt(db, "r1", "2026-06");
  seedExport(db, "e9", "2026-09", "draft");
  db.prepare(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i1','e9','receipt','r1','t')`).run();
  db.prepare(`UPDATE receipt_exports SET status='finalized' WHERE id='e9'`).run();
  // Exact shape: only status/exported_month/updated_at change, justified by the
  // finalized export's published item set.
  assert.equal(
    R(db, `UPDATE receipt_records SET status='exported', exported_month='2026-09', updated_at='t2' WHERE id='r1' AND status IN ('captured','needs_review','reviewed','reconciled')`),
    true,
  );
  // Same shape but the receipt is NOT in the item set → fenced (its own June
  // month is export-locked, and e9's September item set does not justify it).
  seedReceipt(db, "r2", "2026-06");
  seedExport(db, "e6", "2026-06", "finalized");
  assert.equal(
    R(db, `UPDATE receipt_records SET status='exported', exported_month='2026-09', updated_at='t2' WHERE id='r2'`),
    "DZ_SEAL_MONTH_LOCKED",
  );
});

test("A4 archived is terminal; exported→archived maintenance + processor counters pass", () => {
  const db = mk();
  seedReceipt(db, "r6", "2026-06");
  db.prepare(`UPDATE receipt_records SET status='archived' WHERE id='r6'`).run(); // archived pre-seal (unlocked month)
  seedExport(db, "e6", "2026-06", "finalized");
  assert.equal(
    R(db, `UPDATE receipt_records SET amount_minor=1 WHERE id='r6'`),
    "DZ_SEAL_MONTH_LOCKED",
  );
  // exported → archived with lifecycle-only fields is the permitted shape
  // (no writer today — the guard admits it for the future retention path).
  seedReceipt(db, "r7", "2026-07");
  db.prepare(`UPDATE receipt_records SET status='exported', exported_month='2026-07' WHERE id='r7'`).run();
  assert.equal(
    R(db, `UPDATE receipt_records SET status='archived', updated_at='t2' WHERE id='r7'`),
    true,
  );
  // Archived now: lifecycle/preservation maintenance still passes.
  assert.equal(
    R(db, `UPDATE receipt_records SET preservation_status='archived', updated_at='t3' WHERE id='r7'`),
    true,
  );
  // Processor counters / extraction metadata on a SEALED month stay writable.
  seedReceipt(db, "r8", "2026-08");
  seedExport(db, "e8", "2026-08", "finalized"); // after the receipt: guard is for INSERTs INTO the locked month
  assert.equal(
    R(db, `UPDATE receipt_records SET extraction_attempts=extraction_attempts+1, extraction_json='{}', extraction_state='processed', needs_render=0 WHERE id='r8'`),
    true,
  );
});

// ─── Acceptance 5: cascades / deletes ────────────────────────────────────────

test("A5 receipt delete under claim / sealed month fenced; hardDelete order intact", () => {
  const db = mk();
  seedReceipt(db, "r7", "2026-07");
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id) VALUES ('L','2026-07','2026-07-01','m',1,'JPY','confirmed','{}','t','r7')`).run();
  db.prepare(`INSERT INTO receipt_files (id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,file_size_bytes,sha256_hash,uploaded_by,uploaded_at,is_original,created_at,updated_at) VALUES ('f7','receipt','r7','original','receipts','kf7','f','image/jpeg',1,'h','u','t',1,'t','t')`).run();
  seedExport(db, "e7", "2026-07", "draft", "tok", 600);
  assert.equal(R(db, `DELETE FROM receipt_records WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE");
  // The batch a hard delete would run — line unlink first cannot rescue it.
  assert.equal(
    R(db, `UPDATE amex_statement_lines SET matched_receipt_id=NULL, match_status='unmatched' WHERE matched_receipt_id='r7'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  assert.equal(
    R(db, `DELETE FROM receipt_files WHERE object_type='receipt' AND object_id='r7'`),
    "DZ_SEAL_CLAIM_ACTIVE",
  );
  assert.equal(R(db, `DELETE FROM receipt_attendees WHERE receipt_id='r7'`), true); // none seeded; zero-row delete passes
  assert.equal(R(db, `DELETE FROM receipt_records WHERE id='r7'`), "DZ_SEAL_CLAIM_ACTIVE");
  // Row + children intact.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_records WHERE id='r7'`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM amex_statement_lines WHERE matched_receipt_id='r7'`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_files WHERE object_id='r7'`).get().n, 1);
});

test("A5 attendee delete via parent cascade of an UNLOCKED receipt passes; line attendee strict after seal", () => {
  const db = mk();
  seedReceipt(db, "r8", "2026-08");
  db.prepare(`INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('at','r8','x','t')`).run();
  assert.equal(R(db, `DELETE FROM receipt_records WHERE id='r8'`), true);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_attendees`).get().n, 0);

  // Strict line seal: after the reconciliation finalizes, line + line-attendee
  // writes are fenced with NO export-draft carve-out.
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at) VALUES ('L','2026-09','2026-09-01','m',1,'JPY','unmatched','{}','t')`).run();
  db.prepare(`INSERT INTO amex_line_attendees (id,amex_statement_line_id,attendee_name,created_at,updated_at) VALUES ('la','L','x','t','t')`).run();
  db.prepare(`INSERT INTO amex_reconciliations (id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at) VALUES ('ar','2026-09','finalized',1,0,0,'a','t')`).run();
  seedExport(db, "e9d", "2026-09", "draft"); // open correction draft does NOT release the line seal
  assert.equal(R(db, `UPDATE amex_statement_lines SET merchant='x' WHERE id='L'`), "DZ_SEAL_RECON_LOCKED");
  assert.equal(
    R(db, `INSERT INTO amex_line_attendees (id,amex_statement_line_id,attendee_name,created_at,updated_at) VALUES ('la2','L','y','t','t')`),
    "DZ_SEAL_RECON_LOCKED",
  );
  assert.equal(R(db, `DELETE FROM amex_line_attendees WHERE id='la'`), "DZ_SEAL_RECON_LOCKED");
});

// ─── Export-row claim transitions and sealed immutability ────────────────────

test("claim transitions: message fence, steal fence, owned release/publication, expiry", () => {
  const db = mk();
  seedExport(db, "e7", "2026-07", "draft", "tok1", 600);
  // External message mutation against an ACTIVE claim is fenced.
  assert.equal(
    R(db, `UPDATE receipt_exports SET operator_message='x', operator_message_updated_at='t' WHERE id='e7'`),
    "DZ_SEAL_EXPORT_CLAIM",
  );
  // Stealing the lease is fenced.
  assert.equal(
    R(db, `UPDATE receipt_exports SET sealing_token='tok2', sealing_expires_at=${now() + 600} WHERE id='e7'`),
    "DZ_SEAL_EXPORT_CLAIM",
  );
  // Owned release (id + token) passes.
  assert.equal(
    R(db, `UPDATE receipt_exports SET sealing_token=NULL, sealing_expires_at=NULL WHERE id='e7' AND sealing_token='tok1'`),
    true,
  );
  // Re-acquire, then owned publication (buildId := token, claim cleared,
  // message value may change, decision ts may not).
  db.prepare(`UPDATE receipt_exports SET sealing_token='tok3', sealing_expires_at=? WHERE id='e7'`).run(now() + 600);
  assert.equal(
    R(db, `UPDATE receipt_exports SET bundle_build_id='tok3', sealing_token=NULL, sealing_expires_at=NULL, operator_message='v2', status='draft', archive_r2_key='a', bundle_built_at='t2' WHERE id='e7'`),
    true,
  );
  // Publication cannot forge the decision timestamp.
  db.prepare(`UPDATE receipt_exports SET sealing_token='tok4', sealing_expires_at=? WHERE id='e7'`).run(now() + 600);
  assert.equal(
    R(db, `UPDATE receipt_exports SET bundle_build_id='tok4', sealing_token=NULL, sealing_expires_at=NULL, operator_message_updated_at='T' WHERE id='e7'`),
    "DZ_SEAL_EXPORT_CLAIM",
  );
  // EXPIRED claim: edits flow again, re-acquisition over the expired lease works.
  db.prepare(`UPDATE receipt_exports SET sealing_token=NULL, sealing_expires_at=NULL WHERE id='e7'`).run();
  db.prepare(`UPDATE receipt_exports SET sealing_token='tok5', sealing_expires_at=? WHERE id='e7'`).run(now() - 10);
  seedReceipt(db, "r7", "2026-07");
  assert.equal(R(db, `UPDATE receipt_records SET amount_minor=7 WHERE id='r7'`), true);
  assert.equal(
    R(db, `UPDATE receipt_exports SET sealing_token='tok6', sealing_expires_at=${now() + 600} WHERE id='e7' AND (sealing_token IS NULL OR sealing_expires_at IS NULL OR sealing_expires_at<=CAST(strftime('%s','now') AS INTEGER))`),
    true,
  );
});

test("sealed export rows: artifact fields frozen, delivery/retention writable, claimed draft undeletable", () => {
  const db = mk();
  seedExport(db, "e6", "2026-06", "finalized");
  for (const col of ["archive_r2_key", "manifest_sha256", "proofs_r2_key", "bundle_build_id", "bundle_built_at", "operator_message", "payment_due_date", "finalized_at"]) {
    assert.equal(R(db, `UPDATE receipt_exports SET ${col}='zz' WHERE id='e6'`), "DZ_SEAL_EXPORT_SEALED", col);
  }
  assert.equal(R(db, `UPDATE receipt_exports SET status='draft' WHERE id='e6'`), "DZ_SEAL_EXPORT_SEALED");
  assert.equal(R(db, `UPDATE receipt_exports SET delivery_state='delivered' WHERE id='e6'`), true);
  assert.equal(R(db, `UPDATE receipt_exports SET retention_until='t9', legal_hold=0 WHERE id='e6'`), true);
  // Draft under ACTIVE claim cannot be deleted.
  seedExport(db, "e7", "2026-07", "draft", "tok", 600);
  assert.equal(R(db, `DELETE FROM receipt_exports WHERE id='e7'`), "DZ_SEAL_EXPORT_CLAIM");
});

// ─── Reconciliation: explicit unfinalize outside claims; other changes fenced ─

test("reconciliation: explicit unfinalize shape passes; other finalized-row writes fenced", () => {
  const db = mk();
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at) VALUES ('L','2026-09','2026-09-01','m',1,'JPY','unmatched','{}','t')`).run();
  db.prepare(`INSERT INTO amex_reconciliations (id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at,manifest_r2_key,manifest_sha256) VALUES ('ar','2026-09','finalized',1,0,0,'a','t','mk','mh')`).run();
  assert.equal(
    R(db, `UPDATE amex_reconciliations SET status='draft', finalized_by=NULL, finalized_at=NULL WHERE id='ar'`),
    true,
  );
  db.prepare(`UPDATE amex_reconciliations SET status='finalized' WHERE id='ar'`).run();
  assert.equal(R(db, `UPDATE amex_reconciliations SET line_count=5 WHERE id='ar'`), "DZ_SEAL_RECON_LOCKED");
  assert.equal(R(db, `UPDATE amex_reconciliations SET manifest_r2_key='x' WHERE id='ar'`), "DZ_SEAL_RECON_LOCKED");
  assert.equal(R(db, `DELETE FROM amex_reconciliations WHERE id='ar'`), "DZ_SEAL_RECON_LOCKED");
});

// ─── Artifacts retained by a prior seal ──────────────────────────────────────

test("artifact identity retained by a prior seal is immutable and undeletable", () => {
  const db = mk();
  db.prepare(`INSERT INTO amex_statement_artifacts (id,statement_month,r2_key,sha256_hash,file_size_bytes,uploaded_by,uploaded_at,created_at,updated_at,import_status) VALUES ('a1','2026-06','k1','h1',1,'u','t','t','t','parsed')`).run();
  db.prepare(`INSERT INTO amex_reconciliations (id,statement_month,statement_artifact_id,status,line_count,matched_count,no_receipt_count,created_by,created_at) VALUES ('ar','2026-06','a1','finalized',1,0,0,'a','t')`).run();
  assert.equal(R(db, `UPDATE amex_statement_artifacts SET r2_key='k2' WHERE id='a1'`), "DZ_SEAL_ARTIFACT_RETAINED");
  assert.equal(R(db, `UPDATE amex_statement_artifacts SET payment_due_date='2026-07-10' WHERE id='a1'`), "DZ_SEAL_ARTIFACT_RETAINED");
  assert.equal(R(db, `DELETE FROM amex_statement_artifacts WHERE id='a1'`), "DZ_SEAL_ARTIFACT_RETAINED");
  // import_status bookkeeping (the replace flow) stays writable.
  assert.equal(R(db, `UPDATE amex_statement_artifacts SET import_status='replaced', updated_at='t2' WHERE id='a1'`), true);
});

// ─── Items of a finalized export are frozen for independent edits ────────────

test("receipt_export_items of a finalized export reject independent INSERT/UPDATE", () => {
  const db = mk();
  seedExport(db, "e9", "2026-09", "draft");
  db.prepare(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i1','e9','receipt','r1','t')`).run();
  db.prepare(`UPDATE receipt_exports SET status='finalized' WHERE id='e9'`).run();
  assert.equal(
    R(db, `INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i2','e9','receipt','r2','t')`),
    "DZ_SEAL_ITEMS_FROZEN",
  );
  assert.equal(R(db, `UPDATE receipt_export_items SET item_id='r3' WHERE id='i1'`), "DZ_SEAL_ITEMS_FROZEN");
});

// ─── Draft carve-out matrix (acceptance 13, SQL side) ────────────────────────

test("correction matrix: sealed edit refused; open draft releases; claim re-fences", () => {
  const db = mk();
  seedReceipt(db, "r6", "2026-06");
  seedExport(db, "e6", "2026-06", "finalized");
  assert.equal(R(db, `UPDATE receipt_records SET merchant='x' WHERE id='r6'`), "DZ_SEAL_MONTH_LOCKED");
  seedExport(db, "e6d", "2026-06", "draft", undefined, undefined, 2);
  assert.equal(R(db, `UPDATE receipt_records SET merchant='x' WHERE id='r6'`), true);
  // An ACTIVE build claim on the correction draft re-fences the inputs.
  db.prepare(`UPDATE receipt_exports SET sealing_token='tok', sealing_expires_at=? WHERE id='e6d'`).run(now() + 600);
  assert.equal(R(db, `UPDATE receipt_records SET merchant='y' WHERE id='r6'`), "DZ_SEAL_CLAIM_ACTIVE");
});

// ─── Review round 2: B2–B7, B10 permanent/claim matrix (full schema) ─────────

test("R2-B2 permanent OLD-scope escape is fenced: CASH→AMEX with cleared date/membership", () => {
  const db = mk();
  seedReceipt(db, "r6", "2026-06");
  seedExport(db, "e6", "2026-06", "finalized");
  assert.equal(
    R(db, `UPDATE receipt_records SET payment_path='AMEX', transaction_date=NULL, export_statement_month=NULL, amount_minor=999 WHERE id='r6'`),
    "DZ_SEAL_MONTH_LOCKED",
    "all NEW-side CASH predicates vanish — the OLD side must hold the lock",
  );
});

test("R2-B2 finalized item-derived lock survives unfinalize + last-claim unlink", () => {
  const db = mk();
  // AMEX receipt exported via month M2; prior month M1 has an OPEN draft (so
  // the exported-month lock is released); M2's reconciliation is unfinalized
  // and its line unlinked — only the finalized item set remains.
  seedReceipt(db, "r", "2026-06", "AMEX", { status: "exported" });
  db.prepare(`UPDATE receipt_records SET exported_month='2026-05' WHERE id='r'`).run();
  seedExport(db, "open-prior", "2026-05", "draft", undefined, undefined, 2);
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id) VALUES ('l','2026-06','2026-06-10','m',1,'JPY','confirmed','{}','t','r')`).run();
  db.prepare(`INSERT INTO amex_reconciliations (id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at) VALUES ('ar','2026-06','finalized',1,1,0,'a','t')`).run();
  seedExport(db, "e", "2026-06", "draft");
  db.prepare(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i','e','receipt','r','t')`).run();
  db.prepare(`UPDATE receipt_exports SET status='finalized' WHERE id='e'`).run();
  // The reviewer's full escape sequence:
  db.prepare(`UPDATE amex_reconciliations SET status='draft', finalized_by=NULL, finalized_at=NULL WHERE id='ar'`).run();
  db.prepare(`UPDATE amex_statement_lines SET matched_receipt_id=NULL, match_status='unmatched' WHERE id='l'`).run();
  assert.equal(R(db, `UPDATE receipt_records SET amount_minor=999 WHERE id='r'`), "DZ_SEAL_MONTH_LOCKED");
  // A correction draft for the item's month releases it (per-month carve-out).
  seedExport(db, "e-cor", "2026-06", "draft", undefined, undefined, 2);
  assert.equal(R(db, `UPDATE receipt_records SET amount_minor=42 WHERE id='r'`), true);
});

test("R2-B3 sealed attendee UPDATE and reparenting (both directions) are fenced", () => {
  const db = mk();
  seedReceipt(db, "r6", "2026-06");
  seedReceipt(db, "r8", "2026-08");
  db.prepare(`INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('a','r6','before','t')`).run();
  db.prepare(`INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('a8','r8','x','t')`).run();
  seedExport(db, "e6", "2026-06", "finalized");
  assert.equal(R(db, `UPDATE receipt_attendees SET attendee_name='after' WHERE id='a'`), "DZ_SEAL_MONTH_LOCKED");
  assert.equal(R(db, `UPDATE receipt_attendees SET receipt_id='r6' WHERE id='a8'`), "DZ_SEAL_MONTH_LOCKED", "reparent INTO a locked receipt");
  assert.equal(R(db, `UPDATE receipt_attendees SET receipt_id='r8' WHERE id='a'`), "DZ_SEAL_MONTH_LOCKED", "reparent OUT of a locked receipt");
  assert.equal(R(db, `UPDATE receipt_attendees SET attendee_name=attendee_name WHERE id='a8'`), true, "no-op passes");
  // Open-month receipt stays fully editable.
  assert.equal(R(db, `UPDATE receipt_attendees SET attendee_name='ok' WHERE id='a8'`), true);
});

test("R2-B4 cross-month finalized confirmed claim is fenced in SQL; same-month siblings pass", () => {
  const db = mk();
  seedReceipt(db, "r", "2026-06", "AMEX", { status: "reviewed" });
  db.prepare(`UPDATE receipt_records SET export_statement_month=NULL WHERE id='r'`).run();
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id) VALUES ('l','2026-06','2026-06-10','m',1,'JPY','confirmed','{}','t','r')`).run();
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at) VALUES ('other','2026-07','2026-07-10','m',1,'JPY','unmatched','{}','t')`).run();
  db.prepare(`INSERT INTO amex_reconciliations (id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at) VALUES ('ar','2026-06','finalized',1,1,0,'a','t')`).run();
  seedExport(db, "e6d", "2026-06", "draft"); // export correction draft must NOT relax this
  assert.equal(
    R(db, `UPDATE amex_statement_lines SET matched_receipt_id='r', match_status='confirmed' WHERE id='other'`),
    "DZ_SEAL_RECON_LOCKED",
  );
  assert.equal(
    R(db, `INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id) VALUES ('n2','2026-07','2026-07-11','m',1,'JPY','confirmed','{}','t','r')`),
    "DZ_SEAL_RECON_LOCKED",
    "INSERT arm too",
  );
  // A same-month sibling write into the FINALIZED month itself is refused by
  // the strict line seal (rejectIfFinalized semantics — no carve-out); the
  // cross-month trigger's sibling exclusion covers the confirm flow while the
  // month is still open, before its own reconciliation finalizes.
  assert.equal(
    R(db, `INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id) VALUES ('sib','2026-06','2026-06-11','m',1,'JPY','confirmed','{}','t','r')`),
    "DZ_SEAL_RECON_LOCKED",
  );
});

test("R3-F6 finalized item DELETE refuses even WITH a committed marker; only the sanctioned parent cascade removes items", () => {
  const db = mk();
  seedExport(db, "e", "2026-06", "draft");
  db.prepare(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i','e','receipt','r','t')`).run();
  db.prepare(`UPDATE receipt_exports SET status='finalized' WHERE id='e'`).run();
  assert.equal(R(db, `DELETE FROM receipt_export_items WHERE id='i'`), "DZ_SEAL_ITEMS_FROZEN", "unmarked independent delete");
  // Parent delete without the marker: refused BEFORE the FK cascade, items survive.
  assert.equal(R(db, `DELETE FROM receipt_exports WHERE id='e'`), "DZ_SEAL_EXPORT_SEALED");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports`).get().n, 1);
  // F6: a committed marker does NOT authorize an independent item delete.
  db.prepare(`INSERT INTO receipt_audit_log (id,actor,action,object_type,object_id,created_at) VALUES ('au','op','export.deleted','export','e','t')`).run();
  assert.equal(R(db, `DELETE FROM receipt_export_items WHERE id='i'`), "DZ_SEAL_ITEMS_FROZEN", "marked independent delete still refused");
  // The sanctioned path: marker-gated parent DELETE whose FK cascade removes
  // the items (child triggers see the parent already absent).
  assert.equal(R(db, `DELETE FROM receipt_exports WHERE id='e'`), true, "marked parent delete cascades");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports`).get().n, 0);
});

test("R2-B6 artifact selection ordering (created_at) is frozen under a claim", () => {
  const db = mk();
  const art = (id: string, created: string) =>
    db.prepare(`INSERT INTO amex_statement_artifacts (id,statement_month,r2_key,sha256_hash,file_size_bytes,uploaded_by,uploaded_at,created_at,updated_at,import_status) VALUES (?,'2026-06',?,?,1,'a','t',?,'t','parsed')`).run(id, "ak" + id, "sh" + id, created);
  art("a", "2026-01-01");
  art("b", "2026-01-02");
  seedReceipt(db, "r7", "2026-06");
  seedExport(db, "e", "2026-06", "draft", "tok", 600);
  const selection = `SELECT id FROM amex_statement_artifacts WHERE statement_month='2026-06' AND import_status NOT IN ('failed','replaced') ORDER BY created_at DESC LIMIT 1`;
  assert.equal((db.prepare(selection).get() as never as { id: string }).id, "b");
  assert.equal(R(db, `UPDATE amex_statement_artifacts SET created_at='2026-01-03' WHERE id='a'`), "DZ_SEAL_CLAIM_ACTIVE");
  assert.equal((db.prepare(selection).get() as never as { id: string }).id, "b", "selection unchanged");
});

test("R2-B7 file UPDATE into/out of a claimed artifact's ownership is fenced; no-op passes", () => {
  const db = mk();
  db.prepare(`INSERT INTO amex_statement_artifacts (id,statement_month,r2_key,sha256_hash,file_size_bytes,uploaded_by,uploaded_at,created_at,updated_at,import_status) VALUES ('art','2026-06','ak','sh',1,'a','t','t','t','parsed')`).run();
  db.prepare(`INSERT INTO receipt_files (id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,file_size_bytes,sha256_hash,uploaded_by,uploaded_at,is_original,created_at,updated_at) VALUES ('f','receipt','nx','original','receipts','fk','file','text/csv',1,'h','u','t',1,'t','t')`).run();
  db.prepare(`INSERT INTO receipt_files (id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,file_size_bytes,sha256_hash,uploaded_by,uploaded_at,is_original,created_at,updated_at) VALUES ('fa','amex_statement_artifact','art','original','receipts','fka','file','text/csv',1,'h','u','t',1,'t','t')`).run();
  seedReceipt(db, "r7", "2026-06");
  seedExport(db, "e", "2026-06", "draft", "tok", 600);
  assert.equal(
    R(db, `UPDATE receipt_files SET object_type='amex_statement_artifact', object_id='art' WHERE id='f'`),
    "DZ_SEAL_CLAIM_ACTIVE",
    "NEW artifact ownership scope",
  );
  // Movement OUT of a claimed artifact into neutral ownership is fenced too.
  assert.equal(
    R(db, `UPDATE receipt_files SET object_type='receipt', object_id='nx' WHERE id='fa'`),
    "DZ_SEAL_CLAIM_ACTIVE",
    "OLD artifact ownership scope",
  );
  assert.equal(R(db, `UPDATE receipt_files SET uploaded_at=uploaded_at WHERE id='f'`), true, "no-op passes");
});

test("R2-B10 unmatched AMEX work stays allowed under a claim; referenced AMEX receipts stay fenced", () => {
  const db = mk();
  seedReceipt(db, "un", "2026-06", "AMEX", { status: "captured" });
  db.prepare(`UPDATE receipt_records SET export_statement_month=NULL WHERE id='un'`).run();
  seedReceipt(db, "mm", "2026-06", "AMEX", { status: "reviewed" });
  db.prepare(`UPDATE receipt_records SET export_statement_month=NULL WHERE id='mm'`).run();
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id) VALUES ('l','2026-06','2026-06-10','m',1,'JPY','confirmed','{}','t','mm')`).run();
  seedExport(db, "e", "2026-06", "draft", "tok", 600);
  assert.equal(R(db, `UPDATE receipt_records SET amount_minor=200 WHERE id='un'`), true, "unmatched AMEX cannot affect M");
  assert.equal(R(db, `UPDATE receipt_records SET amount_minor=201 WHERE id='mm'`), "DZ_SEAL_CLAIM_ACTIVE", "referenced via M's line");
  // An unmatched AMEX capture dated in M is insertable (only non-AMEX calendar scope fences).
  assert.equal(
    R(db, `INSERT INTO receipt_records (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at) VALUES ('un2','t','a','AMEX','2026-06-05','captured','k','s','image/jpeg',1,'t','t')`),
    true,
  );
});

test("R2 post-seal full payload/date/key escape matrix on a shipped receipt", () => {
  const db = mk();
  seedReceipt(db, "r6", "2026-06");
  seedExport(db, "e6", "2026-06", "draft");
  db.prepare(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i','e6','receipt','r6','t')`).run();
  db.prepare(`UPDATE receipt_exports SET status='finalized' WHERE id='e6'`).run();
  for (const stmt of [
    `UPDATE receipt_records SET amount_minor=1 WHERE id='r6'`,
    `UPDATE receipt_records SET expense_category_code='supplies' WHERE id='r6'`,
    `UPDATE receipt_records SET transaction_date='2026-06-02' WHERE id='r6'`,
    `UPDATE receipt_records SET payment_path='DIGITAL' WHERE id='r6'`,
    `UPDATE receipt_records SET original_r2_key='kk' WHERE id='r6'`,
    `UPDATE receipt_records SET original_sha256='ss' WHERE id='r6'`,
    `UPDATE receipt_records SET deleted_at='t' WHERE id='r6'`,
    `UPDATE receipt_records SET merchant='x' WHERE id='r6'`,
  ]) {
    assert.equal(R(db, stmt), "DZ_SEAL_MONTH_LOCKED", stmt);
  }
  assert.equal(R(db, `DELETE FROM receipt_records WHERE id='r6'`), "DZ_SEAL_MONTH_LOCKED");
});

// ─── Round 3: F1 identity inventory / F7 ordering input ──────────────────────

test("R3-F1 receipt identity (id) is fenced under claim AND after seal; promotion cannot ride an id change", () => {
  const db = mk();
  seedReceipt(db, "r6", "2026-06");
  seedExport(db, "e6", "2026-06", "draft", "tok", 600);
  assert.equal(R(db, `UPDATE receipt_records SET id='r6b' WHERE id='r6'`), "DZ_SEAL_CLAIM_ACTIVE", "claim-time rename");
  // Post-seal rename (reviewer's second probe): the finalized item keeps a live target.
  db.prepare(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i','e6','receipt','r6','t')`).run();
  db.prepare(`UPDATE receipt_exports SET status='finalized', sealing_token=NULL, sealing_expires_at=NULL WHERE id='e6'`).run();
  assert.equal(R(db, `UPDATE receipt_records SET id='r6c' WHERE id='r6'`), "DZ_SEAL_MONTH_LOCKED", "post-seal rename");
  // The promotion exception pins identity: an item-justified export shape
  // riding an id change is refused.
  assert.equal(
    R(db, `UPDATE receipt_records SET id='r6d', status='exported', exported_month='2026-06', updated_at='t2' WHERE id='r6'`),
    "DZ_SEAL_MONTH_LOCKED",
    "promotion exception requires NEW.id IS OLD.id",
  );
});

test("R3-F1 line identity (id) is fenced under claim; directory id too", () => {
  const db = mk();
  seedReceipt(db, "rM", "2026-06", "AMEX", { export_statement_month: null });
  db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at) VALUES ('LM','2026-06','2026-06-01','m',1,'JPY','unmatched','{}','t')`).run();
  seedExport(db, "e6", "2026-06", "draft", "tok", 600);
  assert.equal(R(db, `UPDATE amex_statement_lines SET id='LM2' WHERE id='LM'`), "DZ_SEAL_CLAIM_ACTIVE", "line rename");
  assert.equal(
    R(db, `UPDATE attendee_directory SET id=12345 WHERE id=1`),
    "DZ_SEAL_CLAIM_ACTIVE",
    "directory identity rename (global claim fence)",
  );
  assert.equal(R(db, `UPDATE attendee_directory SET company=company WHERE id=1`), true, "no-op still passes");
});

test("R3-F7 receipt_files.created_at (selection ordering input) is fenced under a claim", () => {
  const db = mk();
  seedReceipt(db, "r7", "2026-07");
  db.prepare(`INSERT INTO receipt_files (id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,file_size_bytes,sha256_hash,uploaded_by,uploaded_at,is_original,created_at,updated_at) VALUES ('f7','receipt','r7','original','receipts','kf7','f','image/jpeg',1,'h','u','t',1,'t','t')`).run();
  seedExport(db, "e7", "2026-07", "draft", "tok", 600);
  assert.equal(R(db, `UPDATE receipt_files SET created_at='2025-01-01T00:00:00Z' WHERE id='f7'`), "DZ_SEAL_CLAIM_ACTIVE");
  assert.equal(R(db, `UPDATE receipt_files SET updated_at=updated_at WHERE id='f7'`), true, "no-op passes");
});
