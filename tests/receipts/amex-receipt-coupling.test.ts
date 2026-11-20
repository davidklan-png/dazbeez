import test from "node:test";
import assert from "node:assert/strict";
import { amexFixture } from "./helpers/amex-sqlite";

const json = (res: Response) => res.json() as Promise<{ code: string; receiptRevisions: Record<string, number>; lineRevisions: Record<string, number> }>;

const receiptRevision = (f: ReturnType<typeof amexFixture>, id = "r") => Number(f.get("SELECT revision FROM receipt_records WHERE id=?", id).revision);
const decision = (f: ReturnType<typeof amexFixture>, id = "l", target: string | null = "r") => {
  const previous = f.get("SELECT matched_receipt_id FROM amex_statement_lines WHERE id=?", id)?.matched_receipt_id;
  const ids = [...new Set([target, previous].filter((id): id is string => typeof id === "string"))];
  return { amexLineId: id, receiptId: target, matchStatus: target ? "confirmed" : "unmatched", expectedRevision: f.revision(id),
    expectedReceipts: Object.fromEntries(ids.map(id => [id, receiptRevision(f, id)])) };
};

test("matching requires loaded receipt snapshots and exact affected context identities", async () => {
  const f = amexFixture(); f.receipt(); f.line();
  const loaded = decision(f);
  for (const expectedReceipts of [undefined, null, [], { r: -1 }, { r: "0" }, { r: 1.5 }]) {
    const res = await f.reconcile({ ...loaded, expectedReceipts });
    assert.equal(res.status, 400);
  }
  for (const expectedReceipts of [{}, { r: 0, unseen: 0 }]) {
    const res = await f.reconcile({ ...loaded, expectedReceipts });
    assert.equal(res.status, 409); assert.equal((await json(res)).code, "amex_receipt_revision_conflict");
  }
  assert.equal(f.auditCount(), 0); assert.equal(f.get("SELECT status FROM receipt_records").status, "reviewed");
});

for (const [writer, sql] of [
  ["operator", "UPDATE receipt_records SET merchant='changed' WHERE id='r'"],
  ["extraction", "UPDATE receipt_records SET extraction_json='{}', extraction_state='processed' WHERE id='r'"],
  ["duplicate merge", "UPDATE receipt_records SET updated_at='same-ms', business_purpose='merged' WHERE id='r'"],
  ["publication", "INSERT INTO receipt_exports(id,export_month,status,created_by,created_at) VALUES ('e','2026-11','draft','fixture','t'); INSERT INTO receipt_export_items(id,export_id,item_type,item_id,created_at) VALUES ('ei','e','receipt','r','t')"],
]) {
  test(`stale non-deleted unlinked candidate refuses ${writer} changes with no side effects`, async () => {
    const f = amexFixture(); f.receipt(); f.line(); const loaded = decision(f);
    f.beforeBatch(() => f.sql.exec(sql));
    const res = await f.reconcile(loaded);
    assert.equal(res.status, 409); assert.equal((await json(res)).code, "amex_receipt_revision_conflict");
    assert.equal(f.get("SELECT matched_receipt_id FROM amex_statement_lines").matched_receipt_id, null);
    assert.equal(f.get("SELECT status FROM receipt_records").status, "reviewed"); assert.equal(f.auditCount(), 0);
  });
}

test("a stale previous receipt context refuses detach/demotion atomically", async () => {
  const f = amexFixture(); f.receipt("old", "reconciled", "AMEX"); f.receipt("new"); f.line("l", "old", "confirmed");
  const loaded = decision(f, "l", "new");
  // A receipt-only admission consumes the token without a business invalidation of the line.
  f.sql.exec(`INSERT INTO receipt_edit_admissions VALUES ('old', ${receiptRevision(f, "old")})`);
  const res = await f.reconcile(loaded);
  assert.equal(res.status, 409); assert.equal(f.get("SELECT matched_receipt_id FROM amex_statement_lines").matched_receipt_id, "old");
  assert.equal(f.get("SELECT status FROM receipt_records WHERE id='old'").status, "reconciled");
  assert.equal(f.get("SELECT status FROM receipt_records WHERE id='new'").status, "reviewed"); assert.equal(f.auditCount(), 0);
});

test("matching returns only admitted affected receipt/line tokens selected before a later writer", async () => {
  const f = amexFixture(); f.receipt("old", "reconciled", "AMEX"); f.receipt("new"); f.line("l", "old", "confirmed"); f.line("sibling", "old", "confirmed");
  const loaded = { ...decision(f, "l", "new"), expectedLines: { sibling: f.revision("sibling") } };
  f.afterBatch(() => f.sql.exec("UPDATE receipt_records SET merchant='later' WHERE id='new'"));
  const res = await f.reconcile(loaded); assert.equal(res.status, 200);
  const ack = await json(res); assert.deepEqual(Object.keys(ack.receiptRevisions).sort(), ["new", "old"]);
  assert.ok(ack.receiptRevisions.new < receiptRevision(f, "new"));
  assert.equal(ack.receiptRevisions.old, receiptRevision(f, "old"));
  assert.equal(ack.lineRevisions.sibling, f.revision("sibling"));
  assert.equal((await f.reconcile({ ...decision(f, "l", "new"), expectedReceipts: ack.receiptRevisions })).status, 409);
});

test("own receipt acknowledgements support consolidated single/bulk decisions; one stale candidate still refuses individually", async () => {
  const f = amexFixture(); f.receipt(); f.receipt("stale"); f.line(); f.line("l2"); f.line("l3");
  const first = decision(f); const second = decision(f, "l2"); const stale = decision(f, "l3", "stale");
  f.sql.exec("UPDATE receipt_records SET extraction_json='{}' WHERE id='stale'");
  const a = await f.reconcile(first); assert.equal(a.status, 200); const ack = await json(a);
  assert.equal((await f.reconcile(stale)).status, 409);
  assert.equal((await f.reconcile({ ...second, expectedReceipts: ack.receiptRevisions })).status, 200);
  assert.equal(f.all("SELECT id FROM amex_statement_lines WHERE match_status='confirmed'").length, 2);
  assert.equal(f.get("SELECT matched_receipt_id FROM amex_statement_lines WHERE id='l3'").matched_receipt_id, null);
});

for (const recursive of [false, true]) {
  test(`reverse business invalidation stays finite without revision loops or refresh conflicts (recursive=${recursive})`, async () => {
    const f = amexFixture(recursive); f.receipt("r1"); f.receipt("r2"); f.line("a", "r1"); f.line("b", "r2"); f.trip("t1"); f.trip("t2");
    const changed = (sql: string, ids: string[]) => {
      const before = ids.map(id => receiptRevision(f, id)); f.sql.exec(sql);
      ids.forEach((id, i) => assert.ok(receiptRevision(f, id) > before[i], sql));
    };
    changed("INSERT INTO amex_line_attendees(id,amex_statement_line_id,attendee_name,created_at,updated_at) VALUES ('a','a','One','t','t')", ["r1"]);
    changed("UPDATE amex_line_attendees SET amex_statement_line_id='b' WHERE id='a'", ["r1", "r2"]);
    changed("DELETE FROM amex_line_attendees WHERE id='a'", ["r2"]);
    changed("INSERT INTO business_trip_report_lines VALUES ('la','t1','a','t')", ["r1"]);
    changed("UPDATE business_trip_report_lines SET business_trip_report_id='t2', amex_statement_line_id='b' WHERE id='la'", ["r1", "r2"]);
    changed("UPDATE business_trip_reports SET purpose='changed' WHERE id='t2'", ["r2"]);
    changed("INSERT INTO business_trip_report_receipts VALUES ('ra','t1','r1','t')", ["r1"]);
    changed("UPDATE business_trip_report_receipts SET business_trip_report_id='t2',receipt_id='r2' WHERE id='ra'", ["r1", "r2"]);
    changed("DELETE FROM business_trip_report_receipts WHERE id='ra'", ["r2"]);
    changed("DELETE FROM business_trip_report_lines WHERE id='la'", ["r2"]);
    const before = [f.revision("a"), receiptRevision(f, "r1"), f.tripRevision("t1")];
    await f.writers.verifyAmexLineReads(await f.writers.listAmexLines("2026-11"));
    await f.writers.verifyReceiptReads([{ id: "r1", revision: before[1] }]);
    assert.deepEqual([f.revision("a"), receiptRevision(f, "r1"), f.tripRevision("t1")], before);
    f.sql.exec("UPDATE receipt_records SET revision=revision+1 WHERE id='r1'");
    assert.equal(f.revision("a"), before[0]); assert.equal(f.tripRevision("t1"), before[2]);
    const receiptToken = receiptRevision(f, "r1");
    f.sql.exec("UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id='a'; UPDATE business_trip_reports SET revision=revision+1 WHERE id='t1'");
    assert.equal(receiptRevision(f, "r1"), receiptToken);
    assert.equal(f.all("PRAGMA foreign_key_check").length, 0);
  });
}

test("receipt-only trip member changes invalidate loaded trip context", async () => {
  const f = amexFixture(); f.receipt(); f.trip(); f.line();
  await f.members("t", { expectedRevision: f.tripRevision(), expectedLines: { l: f.revision() }, lineIds: ["l"], receiptIds: ["r"] });
  const token = f.tripRevision(); const lineToken = f.revision();
  f.sql.exec("UPDATE receipt_records SET extraction_json='{}' WHERE id='r'");
  assert.equal((await f.patchTrip("t", { expectedRevision: token, purpose: "stale" })).status, 409);
  assert.ok(f.revision() > lineToken);
});

for (const first of ["delete", "confirm"]) {
  test(`Delete-versus-confirm admission race: ${first} commits first, losing batch leaves no partial audit`, async () => {
    const f = amexFixture(); f.receipt(); f.line(); const loaded = decision(f); const token = receiptRevision(f);
    if (first === "delete") {
      f.beforeBatch(async () => { await f.writers.softDeleteReceipt("r", "delete", undefined, f.db, token); });
      assert.equal((await f.reconcile(loaded)).status, 409);
      assert.ok(f.get("SELECT deleted_at FROM receipt_records").deleted_at);
      assert.equal(f.get("SELECT matched_receipt_id FROM amex_statement_lines").matched_receipt_id, null);
      assert.equal(f.auditCount(), 1);
    } else {
      f.beforeBatch(async () => { assert.equal((await f.reconcile(loaded)).status, 200); });
      await assert.rejects(f.writers.softDeleteReceipt("r", "delete", undefined, f.db, token), /DZ_RECEIPT_REVISION_CONFLICT/);
      assert.equal(f.get("SELECT deleted_at FROM receipt_records").deleted_at, null);
      assert.equal(f.get("SELECT matched_receipt_id FROM amex_statement_lines").matched_receipt_id, "r");
      assert.equal(f.auditCount(), 2);
    }
  });
}
