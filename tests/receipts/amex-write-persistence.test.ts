import test from "node:test";
import assert from "node:assert/strict";
import { amexFixture } from "./helpers/amex-sqlite";
const json = (res: Response) => res.json() as Promise<{ code: string; revision: number; lines: number; receipts: number; unchangedLines: number; unchangedReceipts: number; lineRevisions: Record<string, number> }>;

function snapshots(f: ReturnType<typeof amexFixture>, lineId: string, receiptId?: string | null) {
  const previous = f.get("SELECT matched_receipt_id FROM amex_statement_lines WHERE id=?", lineId)?.matched_receipt_id;
  return Object.fromEntries([...new Set([receiptId, previous].filter((id): id is string => typeof id === "string"))]
    .map(id => [id, Number(f.get("SELECT revision FROM receipt_records WHERE id=?", id)?.revision ?? 0)]));
}
function reconcile(f: ReturnType<typeof amexFixture>, body: { amexLineId: string; receiptId?: string | null; matchStatus: string; expectedRevision: unknown }) {
  return f.reconcile({ ...body, expectedReceipts: snapshots(f, body.amexLineId, body.receiptId) });
}

test("routes require safe loaded revisions; authentication still runs first", async () => {
  const f = amexFixture(); f.line(); f.trip();
  for (const token of [undefined, null, -1, 1.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
    const res = await f.patch("l", { expectedRevision: token });
    assert.equal(res.status, 400); assert.match((await json(res)).code, /expected_revision/);
    assert.equal((await reconcile(f, { amexLineId: "l", matchStatus: "no_receipt", expectedRevision: token })).status, 400);
    assert.equal((await f.patchTrip("t", { expectedRevision: token })).status, 400);
  }
  assert.equal((await f.patch("l", {}, true)).status, 401);
  assert.equal(f.revision(), 0); assert.equal(f.auditCount(), 0);
});

test("one winner for two same-token editors, including same-ms/same-value/empty operations", async () => {
  const f = amexFixture(); f.line();
  const [a, b] = await Promise.all([
    f.patch("l", { expectedRevision: 0, expenseCategoryCode: "supplies" }),
    f.patch("l", { expectedRevision: 0, expenseCategoryCode: "communications" }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const refused = a.status === 409 ? a : b;
  assert.equal((await json(refused)).code, "amex_line_revision_conflict");
  const audits = f.auditCount(); const token = f.revision();
  const empty = await f.patch("l", { expectedRevision: token });
  assert.equal(empty.status, 200); assert.ok((await json(empty)).revision > token);
  assert.equal(f.auditCount(), audits, "empty sparse PATCH must not fabricate category audit");
  assert.equal((await f.patch("l", { expectedRevision: token })).status, 409);
});

test("missing and disappeared identities refuse even {} and attendees:[] without success audits", async () => {
  const f = amexFixture();
  for (const extra of [{}, { attendees: [] }, { expenseCategoryCode: "supplies" }]) {
    assert.equal((await f.patch("retired", { expectedRevision: 0, ...extra })).status, 404);
  }
  f.line(); f.beforeBatch(() => f.sql.exec("DELETE FROM amex_statement_lines WHERE id='l'"));
  assert.equal((await f.patch("l", { expectedRevision: 0, attendees: [] })).status, 404);
  assert.equal(f.auditCount(), 0);
});

for (const failure of ["category", "roster", "audit"]) {
  test(`combined sparse fields/roster/token/audit roll back on ${failure} failure`, async () => {
    const f = amexFixture(); f.line();
    let res = await f.patch("l", { expectedRevision: f.revision(), attendees: ["Old"], receiptMissingReason: "Keep" });
    assert.equal(res.status, 200);
    const before = f.revision(); const audits = f.auditCount();
    const table = failure === "category" ? "amex_statement_lines" : failure === "roster" ? "amex_line_attendees" : "receipt_audit_log";
    const event = failure === "category" ? "UPDATE OF expense_category_code" : "INSERT";
    f.sql.exec(`CREATE TRIGGER fixture_failure BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    res = await f.patch("l", { expectedRevision: before, expenseCategoryCode: "supplies", attendees: ["New"], receiptMissingReason: null });
    assert.equal(res.status, 500); assert.equal(f.revision(), before); assert.equal(f.auditCount(), audits);
    assert.equal(f.get("SELECT attendee_name FROM amex_line_attendees").attendee_name, "Old");
    assert.equal(f.get("SELECT expense_category_code, receipt_missing_reason FROM amex_statement_lines").expense_category_code, null);
    assert.equal(f.get("SELECT receipt_missing_reason FROM amex_statement_lines").receipt_missing_reason, "Keep");
  });
}

test("attendees-only and empty replacement consume tokens, sparse category preserves nullable siblings", async () => {
  const f = amexFixture(); f.line();
  assert.equal((await f.patch("l", { expectedRevision: f.revision(), attendees: ["村上多寿子"], receiptMissingReason: "Keep", receiptStatus: "receipt_not_available" })).status, 200);
  const before = f.revision();
  assert.equal((await f.patch("l", { expectedRevision: before, attendees: [] })).status, 200);
  assert.ok(f.revision() > before); assert.equal(f.all("SELECT * FROM amex_line_attendees").length, 0);
  assert.equal((await f.patch("l", { expectedRevision: f.revision(), expenseCategoryCode: "supplies" })).status, 200);
  assert.equal(f.get("SELECT receipt_missing_reason FROM amex_statement_lines").receipt_missing_reason, "Keep");
  assert.equal(f.get("SELECT receipt_status FROM amex_statement_lines").receipt_status, "receipt_not_available");
});

test("exact acknowledgement is selected in batch, not a post-commit latest-token read", async () => {
  const f = amexFixture(); f.receipt(); f.line("l", "r", "confirmed"); f.line("sibling", "r", "confirmed");
  const loaded = f.revision();
  f.afterBatch(() => f.sql.exec("UPDATE amex_statement_lines SET memo='later' WHERE id='l'"));
  const res = await f.patch("l", { expectedRevision: loaded, expenseCategoryCode: "supplies", attendees: [] });
  const ack = await json(res); assert.equal(res.status, 200); assert.ok(ack.revision < f.revision());
  assert.equal(ack.lineRevisions.l, ack.revision);
  assert.ok(ack.lineRevisions.sibling < f.revision("sibling"));
  assert.equal((await f.patch("l", { expectedRevision: ack.revision, attendees: ["Old draft"] })).status, 409);
  assert.equal((await f.patch("sibling", { expectedRevision: ack.lineRevisions.sibling, expenseCategoryCode: "communications" })).status, 409);
});

test("missing line cannot classify a supplied valid receipt; race disappearance also has no receipt effects", async () => {
  const f = amexFixture(); f.receipt();
  assert.equal((await reconcile(f, { amexLineId: "gone", receiptId: "r", matchStatus: "confirmed", expectedRevision: 0 })).status, 404);
  f.line(); const revision = f.revision();
  f.beforeBatch(() => f.sql.exec("DELETE FROM amex_statement_lines WHERE id='l'"));
  assert.equal((await reconcile(f, { amexLineId: "l", receiptId: "r", matchStatus: "confirmed", expectedRevision: revision })).status, 404);
  assert.equal(f.get("SELECT payment_path, status FROM receipt_records").payment_path, "UNKNOWN");
  assert.equal(f.get("SELECT status FROM receipt_records").status, "reviewed"); assert.equal(f.auditCount(), 0);
});

test("missing/deleted candidates refuse in transaction; match plus receipt audit failure rolls back all", async () => {
  const f = amexFixture(); f.receipt(); f.line();
  const match = (id: string) => reconcile(f, { amexLineId: "l", receiptId: id, matchStatus: "confirmed", expectedRevision: f.revision() });
  assert.equal((await match("absent")).status, 404);
  f.beforeBatch(() => f.sql.exec("UPDATE receipt_records SET deleted_at='gone' WHERE id='r'"));
  assert.equal((await match("r")).status, 409);
  f.sql.exec("UPDATE receipt_records SET deleted_at=NULL WHERE id='r'");
  const before = f.revision();
  f.sql.exec("CREATE TRIGGER audit_tail BEFORE INSERT ON receipt_audit_log WHEN NEW.object_type='receipt' BEGIN SELECT RAISE(ABORT,'audit tail'); END");
  assert.equal((await match("r")).status, 500);
  assert.equal(f.revision(), before); assert.equal(f.auditCount(), 0);
  assert.equal(f.get("SELECT matched_receipt_id FROM amex_statement_lines").matched_receipt_id, null);
  assert.equal(f.get("SELECT status FROM receipt_records").status, "reviewed");
});

test("match preserves UNKNOWN classification, merchant/date adoption, re-review clearing, and atomic audits", async () => {
  const f = amexFixture(); f.receipt(); f.line();
  f.sql.exec("UPDATE amex_statement_lines SET re_review_needed=1 WHERE id='l'");
  const res = await reconcile(f, { amexLineId: "l", receiptId: "r", matchStatus: "confirmed", expectedRevision: f.revision() });
  assert.equal(res.status, 200); assert.equal((await json(res)).revision, f.revision());
  const r = f.get("SELECT payment_path,merchant,transaction_date,status FROM receipt_records");
  assert.deepEqual({ ...r }, { payment_path: "AMEX", merchant: "AMEX merchant", transaction_date: "2026-11-01", status: "reconciled" });
  assert.equal(f.get("SELECT re_review_needed FROM amex_statement_lines").re_review_needed, 0);
  const audits = f.all("SELECT old_value_json,new_value_json FROM receipt_audit_log"); assert.equal(audits.length, 2);
  assert.equal(JSON.parse(audits[0].old_value_json as string).matchStatus, "unmatched");
});

test("consolidated claims remain supported; unlink demotes only without surviving confirmed claims", async () => {
  const f = amexFixture(); f.receipt(); f.line(); f.line("l2");
  for (const id of ["l", "l2"]) {
    assert.equal((await reconcile(f, { amexLineId: id, receiptId: "r", matchStatus: "confirmed", expectedRevision: f.revision(id) })).status, 200);
  }
  assert.equal((await reconcile(f, { amexLineId: "l", receiptId: null, matchStatus: "unmatched", expectedRevision: f.revision() })).status, 200);
  assert.equal(f.get("SELECT status FROM receipt_records").status, "reconciled");
  assert.equal((await reconcile(f, { amexLineId: "l2", receiptId: null, matchStatus: "unmatched", expectedRevision: f.revision("l2") })).status, 200);
  assert.equal(f.get("SELECT status FROM receipt_records").status, "needs_review");
});

for (const recursive of [false, true]) {
  test(`direct writers invalidate OLD/NEW relationships with recursive_triggers=${recursive}`, async () => {
    const f = amexFixture(recursive); f.receipt("r1"); f.receipt("r2"); f.line("a", "r1"); f.line("b", "r2"); f.trip("t1"); f.trip("t2");
    const changed = (sql: string, ids: string[]) => { const old = ids.map(id => f.revision(id)); f.sql.exec(sql); ids.forEach((id, i) => assert.ok(f.revision(id) > old[i], sql)); };
    changed("UPDATE receipt_records SET merchant='extraction' WHERE id='r1'", ["a"]);
    changed("INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('att','r1','One','t')", ["a"]);
    changed("UPDATE receipt_attendees SET receipt_id='r2' WHERE id='att'", ["a", "b"]);
    changed("INSERT INTO receipt_files(id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,file_size_bytes,sha256_hash,uploaded_by,uploaded_at,is_original,created_at,updated_at) VALUES ('file','receipt','r1','original','fixture','file','x','image/png',1,'hash','fixture','t',1,'t','t')", ["a"]);
    changed("UPDATE receipt_files SET object_id='r2' WHERE id='file'", ["a", "b"]);
    changed("UPDATE amex_statement_lines SET matched_receipt_id='r2' WHERE id='a'", ["a", "b"]);
    changed("INSERT INTO amex_line_attendees(id,amex_statement_line_id,attendee_name,created_at,updated_at) VALUES ('la','a','One','t','t')", ["a"]);
    changed("UPDATE amex_line_attendees SET amex_statement_line_id='b' WHERE id='la'", ["a", "b"]);
    changed("UPDATE amex_statement_lines SET business_trip_id='t1' WHERE id='a'", ["a"]);
    changed("INSERT INTO business_trip_report_lines VALUES ('m','t1','a','t')", ["a"]);
    changed("UPDATE business_trip_report_lines SET business_trip_report_id='t2',amex_statement_line_id='b' WHERE id='m'", ["a", "b"]);
    // Pointer NULL after rejection still has a retained link-table owner.
    changed("UPDATE business_trip_reports SET purpose='Changed' WHERE id='t2'", ["b"]);
    changed("INSERT INTO business_trip_report_receipts VALUES ('mr','t2','r1','t')", ["b"]);
    changed("UPDATE business_trip_report_receipts SET business_trip_report_id='t1' WHERE id='mr'", ["a", "b"]);
    assert.equal(f.all("SELECT * FROM amex_write_assertions").length, 0);
  });
}

test("identity-preserving import metadata invalidates old line editor; retired ids are removed", async () => {
  const f = amexFixture();
  const input = { statementMonth: "2026-11", transactionDate: "2026-11-01", merchant: "Imported", amountMinor: 100, rawJson: "{}", cardholderName: "Fixture" };
  await f.writers.importAmexLines([input], "fixture"); const id = f.get("SELECT id FROM amex_statement_lines").id as string; const before = f.revision(id);
  await f.writers.importAmexLines([{ ...input, memo: "new CSV metadata" }], "fixture");
  assert.ok(f.revision(id) > before); assert.equal((await f.patch(id, { expectedRevision: before, expenseCategoryCode: "supplies" })).status, 409);
  f.sql.prepare("DELETE FROM amex_statement_lines WHERE id=?").run(id);
  assert.equal(f.revision(id), undefined); assert.equal((await f.patch(id, { expectedRevision: before })).status, 404);
});

test("trip membership returns actual changed/unchanged counts and exact in-batch tokens", async () => {
  const f = amexFixture(); f.line(); f.trip(); f.receipt();
  const body = () => ({ expectedRevision: f.tripRevision(), expectedLines: { l: f.revision() }, lineIds: ["l"], receiptIds: ["r"] });
  let res = await f.members("t", body()); assert.equal(res.status, 200); let ack = await json(res);
  assert.equal(ack.lines, 1); assert.equal(ack.receipts, 1); assert.equal(ack.lineRevisions.l, f.revision());
  res = await f.members("t", body()); ack = await json(res); assert.equal(res.status, 200);
  assert.equal(ack.lines, 0); assert.equal(ack.unchangedLines, 1); assert.equal(ack.receipts, 0); assert.equal(ack.unchangedReceipts, 1);
  res = await f.members("t", body(), false); assert.equal(res.status, 200); ack = await json(res); assert.equal(ack.lines, 1); assert.equal(ack.lineRevisions.l, f.revision());
});

test("stale trip context, exact member-set changes, and concurrent cross-trip attach refuse atomically", async () => {
  const f = amexFixture(); f.line(); f.line("new"); f.trip(); f.trip("other");
  await f.members("t", { expectedRevision: f.tripRevision(), expectedLines: { l: f.revision() }, lineIds: ["l"] });
  const before = f.tripRevision(); const lineRev = f.revision();
  f.sql.exec("UPDATE business_trip_reports SET purpose='other editor' WHERE id='t'");
  assert.equal((await f.patchTrip("t", { status: "confirmed", expectedRevision: before, expectedLines: { l: lineRev } })).status, 409);
  const current = f.tripRevision();
  assert.equal((await f.patchTrip("t", { status: "confirmed", expectedRevision: current, expectedLines: {} })).status, 409);
  const audits = f.auditCount();
  f.beforeBatch(() => f.sql.exec("UPDATE amex_statement_lines SET business_trip_id='other' WHERE id='new'"));
  assert.equal((await f.members("t", { expectedRevision: current, expectedLines: { new: f.revision("new") }, lineIds: ["new"] })).status, 409);
  assert.equal(f.auditCount(), audits); assert.equal(f.get("SELECT status FROM business_trip_reports WHERE id='t'").status, "candidate");
});

test("whole-trip sealed-member failure rolls back trip metadata/status/all member lines and audit", async () => {
  const f = amexFixture(); f.line(); f.line("open", null, "unmatched", "2026-12"); f.trip();
  await f.members("t", { expectedRevision: f.tripRevision(), expectedLines: { l: f.revision(), open: f.revision("open") }, lineIds: ["l", "open"] });
  f.seal(); const before = f.tripRevision(); const audits = f.auditCount();
  const res = await f.patchTrip("t", { expectedRevision: before, expectedLines: { l: f.revision(), open: f.revision("open") }, status: "confirmed", purpose: "must roll back" });
  assert.equal(res.status, 409); assert.equal(f.tripRevision(), before); assert.equal(f.auditCount(), audits);
  assert.equal(f.get("SELECT purpose,status FROM business_trip_reports").purpose, null);
  assert.equal(f.get("SELECT status FROM business_trip_reports").status, "candidate");
  assert.ok(f.all("SELECT business_trip_status FROM amex_statement_lines").every(l => l.business_trip_status === "candidate"));
});

test("legal sealed-receipt overlay changes trip context without changing financial rows", async () => {
  const f = amexFixture(); f.receipt(); f.line("l", "r", "confirmed"); f.trip(); f.seal();
  const financialReceipt = () => Object.fromEntries(Object.entries(f.get("SELECT * FROM receipt_records")).filter(([k]) => k !== "revision"));
  const receiptBefore = JSON.stringify(financialReceipt()); const lineBefore = JSON.stringify(f.get("SELECT * FROM amex_statement_lines"));
  const res = await f.members("t", { expectedRevision: f.tripRevision(), expectedLines: {}, receiptIds: ["r"] });
  assert.equal(res.status, 200); assert.equal(JSON.stringify(financialReceipt()), receiptBefore);
  assert.equal(JSON.stringify(f.get("SELECT * FROM amex_statement_lines")), lineBefore);
  assert.equal((await f.patch("l", { expectedRevision: f.revision() })).status, 409);
});

test("read verification refuses changed aggregates rather than stamping fresh tokens onto old fields", async () => {
  const f = amexFixture(); f.line(); const loaded = await f.writers.listAmexLines("2026-11");
  f.sql.exec("UPDATE amex_statement_lines SET memo='raced import metadata' WHERE id='l'");
  await assert.rejects(f.writers.verifyAmexLineReads(loaded), /changed/);
});

test("trip audit-tail failure rolls back member changes, status, and all tokens", async () => {
  const f = amexFixture(); f.line(); f.trip();
  await f.members("t", { lineIds: ["l"], expectedRevision: f.tripRevision(), expectedLines: { l: f.revision() } });
  const lineBefore = f.revision(); const tripBefore = f.tripRevision(); const audits = f.auditCount();
  f.sql.exec("CREATE TRIGGER fail_trip_audit BEFORE INSERT ON receipt_audit_log WHEN NEW.object_type='business_trip' BEGIN SELECT RAISE(ABORT,'trip audit failure'); END");
  const response = await f.patchTrip("t", { status: "confirmed", expectedRevision: tripBefore, expectedLines: { l: lineBefore } });
  assert.equal(response.status, 500); assert.equal(f.revision(), lineBefore); assert.equal(f.tripRevision(), tripBefore); assert.equal(f.auditCount(), audits);
  assert.equal(f.get("SELECT status FROM business_trip_reports").status, "candidate");
  assert.equal((await f.members("t", { lineIds: ["l"], expectedRevision: tripBefore, expectedLines: { l: lineBefore } }, false)).status, 500);
  assert.equal(f.all("SELECT * FROM business_trip_report_lines").length, 1); assert.equal(f.revision(), lineBefore);
});

test("detection cannot undo a later operator exclusion or claim; its audit shares rollback", async () => {
  const f = amexFixture(); f.line(); f.trip();
  const candidate = { cardholderName: "Fixture", startDate: "2026-11-01", endDate: "2026-11-02", primaryLocation: "Fixture", lineIds: ["l"] };
  f.beforeBatch(() => f.sql.exec("UPDATE amex_statement_lines SET business_trip_status='excluded' WHERE id='l'"));
  await f.writers.createBusinessTripReports([candidate], "fixture");
  assert.equal(f.all("SELECT * FROM business_trip_report_lines").length, 0);
  assert.equal(f.get("SELECT business_trip_status FROM amex_statement_lines").business_trip_status, "excluded");
  f.sql.exec("UPDATE amex_statement_lines SET business_trip_status='candidate' WHERE id='l'");
  const before = f.revision(); const audits = f.auditCount();
  f.sql.exec("CREATE TRIGGER fail_detection_audit BEFORE INSERT ON receipt_audit_log BEGIN SELECT RAISE(ABORT,'detection audit'); END");
  await assert.rejects(f.writers.createBusinessTripReports([candidate], "fixture"), /detection audit/);
  assert.equal(f.all("SELECT * FROM business_trip_report_lines").length, 0); assert.equal(f.revision(), before); assert.equal(f.auditCount(), audits);
});

test("0048 seeds existing sealed lines without UPDATEing any financial row", () => {
  let before = "";
  const f = amexFixture(true, sql => {
    sql.exec(`INSERT INTO amex_statement_lines(id, statement_month, transaction_date, merchant, amount_minor, raw_json, created_at)
      VALUES ('sealed','2026-11','2026-11-01','Sealed merchant',100,'{}','t');
      INSERT INTO amex_reconciliations(id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at)
      VALUES ('seal','2026-11','finalized',1,0,0,'fixture','t');`);
    before = JSON.stringify(sql.prepare("SELECT * FROM amex_statement_lines").get());
  });
  assert.equal(f.revision("sealed"), 0);
  assert.equal(JSON.stringify(f.get("SELECT * FROM amex_statement_lines")), before);
});

test("every direct line column write invalidates its token, including import-only metadata", () => {
  const f = amexFixture(); f.line();
  for (const { name } of f.all("PRAGMA table_info(amex_statement_lines)")) {
    const before = f.revision();
    f.sql.exec(`UPDATE amex_statement_lines SET "${name}"="${name}" WHERE id='l'`);
    assert.ok(f.revision() > before, String(name));
  }
});

test("receipt/context changes fence trip metadata acknowledgement instead of blessing unseen member tokens", async () => {
  const f = amexFixture(); f.receipt(); f.line("l", "r"); f.trip();
  await f.members("t", { lineIds: ["l"], expectedRevision: f.tripRevision(), expectedLines: { l: f.revision() } });
  const before = f.tripRevision();
  f.sql.exec("UPDATE receipt_records SET merchant='external extraction' WHERE id='r'");
  assert.ok(f.tripRevision() > before);
  const response = await f.patchTrip("t", { expectedRevision: before, purpose: "loaded before extraction" });
  assert.equal(response.status, 409); assert.equal(f.get("SELECT purpose FROM business_trip_reports").purpose, null);
});
