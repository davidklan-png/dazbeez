import test, { mock, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error Node22 runtime.
import { DatabaseSync } from "node:sqlite";
import { SaveQueue } from "@/lib/receipts/save-queue";

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON");
  for (const f of readdirSync("db/receipts").filter(f => f.endsWith(".sql")).sort()) sql.exec(readFileSync(`db/receipts/${f}`, "utf8"));
  sql.exec(`INSERT INTO receipt_records
    (id,captured_at,captured_by,payment_path,status,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at)
    VALUES ('r1','t','a','UNKNOWN','captured','k','s','image/jpeg',1,'t','t')`);
  let beforeBatch: (() => void) | undefined;
  let loseAck = false;
  let afterCommit: (() => void) | undefined;
  let afterRead: (() => void) | undefined;
  const prepare = (text: string) => {
    const make = (args: unknown[] = []) => ({
      text, args, bind: (...values: unknown[]) => make(values),
      first: async () => {
        const row = sql.prepare(text).get(...args);
        const hook = afterRead; afterRead = undefined; hook?.();
        return row ?? null;
      },
      all: async () => ({ results: sql.prepare(text).all(...args) }),
      run: async () => ({ success: true, meta: { changes: Number(sql.prepare(text).run(...args).changes) } }),
    });
    return make();
  };
  const db = { prepare, async batch(stmts: ReturnType<typeof prepare>[]) {
    const hook = beforeBatch; beforeBatch = undefined; hook?.();
    sql.exec("BEGIN");
    let results;
    try {
      results = stmts.map(s => /^\s*SELECT/i.test(s.text)
        ? { success: true, results: sql.prepare(s.text).all(...s.args), meta: { changes: 0 } }
        : { success: true, results: [], meta: { changes: Number(sql.prepare(s.text).run(...s.args).changes) } });
      sql.exec("COMMIT");
    } catch (e) { sql.exec("ROLLBACK"); throw e; }
    const committed = afterCommit; afterCommit = undefined; committed?.();
    if (loseAck) throw new Error("Lost response after COMMIT");
    return results;
  } } as unknown as D1Database;
  return { sql, db, afterRead: (fn: () => void) => { afterRead = fn; }, afterCommit: (fn: () => void) => { afterCommit = fn; }, beforeBatch: (fn: () => void) => { beforeBatch = fn; }, loseAck: () => { loseAck = true; },
    revision: () => (sql.prepare("SELECT revision FROM receipt_records WHERE id='r1'").get() as { revision: number }).revision,
    audits: () => sql.prepare("SELECT * FROM receipt_audit_log").all(),
  };
}
let current: ReturnType<typeof fixture>;
mock.module("@/lib/cloudflare-runtime", { namedExports: { getReceiptsDb: () => current.db } });
mock.module("@/lib/receipts/auth", { namedExports: { requireReceiptsActor: async () => "operator" } });
mock.module("@/lib/receipts/compliance", { namedExports: { runComplianceChecksForReceipt: async () => {}, listChecksForObject: async () => [] } });
mock.module("@/lib/receipts/settings", { namedExports: { getComplianceSettings: async () => ({}) } });
let updateReceiptRecord: typeof import("@/lib/receipts/db").updateReceiptRecord;
let softDeleteReceipt: typeof import("@/lib/receipts/db").softDeleteReceipt;
let route: typeof import("@/app/api/receipts/[id]/route");
before(async () => {
  ({ updateReceiptRecord, softDeleteReceipt } = await import("@/lib/receipts/db"));
  route = await import("@/app/api/receipts/[id]/route");
});
const context = { params: Promise.resolve({ id: "r1" }) };
const request = (method: string, body: unknown) => new Request("http://localhost/api/receipts/r1", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("two clients / same millisecond: one aggregate admission, stale roster and audits untouched", async () => {
  current = fixture();
  const outcomes = await Promise.allSettled([
    updateReceiptRecord("r1", { merchant: "B" }, "b", { expectedRevision: 0, attendees: [{ attendeeName: "B" }] }, current.db),
    updateReceiptRecord("r1", { merchant: "A" }, "a", { expectedRevision: 0, attendees: [{ attendeeName: "A" }] }, current.db),
  ]);
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  assert.match(String((outcomes.find(o => o.status === "rejected") as PromiseRejectedResult).reason), /DZ_RECEIPT_REVISION_CONFLICT/);
  assert.deepEqual(current.sql.prepare("SELECT attendee_name FROM receipt_attendees").all().map((r: { attendee_name: string }) => r.attendee_name), ["B"]);
  assert.equal(current.audits().length, 2);
  assert.equal((outcomes[0] as PromiseFulfilledResult<number>).value, current.revision());
  assert.equal(current.sql.prepare("SELECT * FROM receipt_edit_admissions").all().length, 0);
});

test("attendee-only, membership and processor edits invalidate loaded browser tokens", async () => {
  current = fixture();
  const revision = await updateReceiptRecord("r1", {}, "op", { expectedRevision: 0, attendees: [{ attendeeName: "参加者" }] }, current.db);
  assert.ok(revision > 0);
  await assert.rejects(updateReceiptRecord("r1", { merchant: "stale" }, "op", { expectedRevision: 0 }, current.db), /REVISION_CONFLICT/);
  current.sql.exec("UPDATE receipt_records SET extraction_json='{}', updated_at='same-ms'");
  current.sql.exec("UPDATE receipt_records SET extraction_json='{}', updated_at='same-ms'");
  assert.equal(current.revision(), revision + 2);
  await assert.rejects(updateReceiptRecord("r1", {}, "op", { expectedRevision: revision, attendees: [] }, current.db), /REVISION_CONFLICT/);
  const r = current.revision();
  const ack = await updateReceiptRecord("r1", { paymentPath: "CASH", transactionDate: "2026-11-10" }, "op", { expectedRevision: r }, current.db);
  assert.equal(ack, current.revision());
  assert.ok(ack > r);
  assert.equal((current.sql.prepare("SELECT export_statement_month FROM receipt_records").get() as { export_statement_month: string }).export_statement_month, "2026-11");
});

test("admission races: deletion or processor write immediately before batch leaves no success audit", async () => {
  for (const change of ["UPDATE receipt_records SET merchant='processor'", "DELETE FROM receipt_records"]) {
    current = fixture();
    current.beforeBatch(() => current.sql.exec(change));
    await assert.rejects(updateReceiptRecord("r1", { merchant: "browser" }, "op", { expectedRevision: 0 }, current.db), /REVISION_CONFLICT/);
    assert.equal(current.audits().length, 0);
  }
  current = fixture();
  current.afterRead(() => current.sql.exec("DELETE FROM receipt_records"));
  const missing = await route.PATCH(request("PATCH", { expectedRevision: 0, merchant: "late" }), context);
  assert.equal(missing.status, 404);
  assert.equal(current.audits().length, 0);
});

test("audit-tail failure rolls back fields, automatic membership, roster and revisions", async () => {
  current = fixture();
  current.sql.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON receipt_audit_log WHEN NEW.new_value_json LIKE '%attendees%' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  await assert.rejects(updateReceiptRecord("r1", { paymentPath: "CASH", transactionDate: "2026-11-10", merchant: "changed" }, "op", { expectedRevision: 0, attendees: [{ attendeeName: "A" }] }, current.db), /audit failure/);
  assert.equal(current.revision(), 0);
  assert.equal(current.audits().length, 0);
  assert.equal(current.sql.prepare("SELECT * FROM receipt_attendees").all().length, 0);
  const row = current.sql.prepare("SELECT merchant, export_statement_month FROM receipt_records").get();
  assert.equal(row.merchant, null); assert.equal(row.export_statement_month, null);
});

test("stale Delete and audit failure are atomic; empty PATCH consumes its token without a field audit", async () => {
  current = fixture();
  assert.equal(await updateReceiptRecord("r1", {}, "op", { expectedRevision: 0 }, current.db), 1);
  assert.equal(current.audits().length, 0);
  current.sql.exec("UPDATE receipt_records SET merchant='processor'");
  await assert.rejects(softDeleteReceipt("r1", "op", undefined, current.db, 0), /REVISION_CONFLICT/);
  assert.equal(current.audits().length, 0);
  current.sql.exec("CREATE TRIGGER fail_delete_audit BEFORE INSERT ON receipt_audit_log BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  await assert.rejects(softDeleteReceipt("r1", "op", undefined, current.db, current.revision()), /audit failure/);
  assert.equal(current.sql.prepare("SELECT deleted_at FROM receipt_records").get().deleted_at, null);
});

test("real route + queue: committed response lost halts with newer typing preserved", async () => {
  current = fixture();
  let merchant = "first";
  let calls = 0;
  const queue = new SaveQueue({ url: "/api/receipts/r1", initialRevision: 0, buildBody: () => ({ merchant }), fetchImpl: async (_url, init) => {
    calls++;
    await route.PATCH(request("PATCH", JSON.parse(init.body as string)), context);
    merchant = "newer local typing";
    throw new Error("response lost");
  } });
  await assert.rejects(queue.save(), /uncertain/);
  assert.equal(current.sql.prepare("SELECT merchant FROM receipt_records").get().merchant, "first");
  await assert.rejects(queue.save(), /uncertain/);
  assert.equal(merchant, "newer local typing"); assert.equal(calls, 1);
});

test("GET seeds token; PATCH/override/Delete require token and return machine-readable conflict", async () => {
  current = fixture();
  const get = await route.GET(new Request("http://localhost/api/receipts/r1"), context);
  assert.equal(((await get.json()) as { receipt: { revision: number } }).receipt.revision, 0);
  for (const method of ["PATCH", "DELETE"]) {
    const handler = method === "PATCH" ? route.PATCH : route.DELETE;
    assert.equal((await handler(request(method, {}), context)).status, 400);
  }
  const saved = await route.PATCH(request("PATCH", { expectedRevision: 0, merchant: "saved" }), context);
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json()) as { revision: number }).revision, current.revision());
  for (const body of [{ merchant: "stale" }, { exportStatementMonth: "2026-11", paymentPath: "CASH" }]) {
    // Override eligibility is validated before admission; use a CASH fixture.
    current.sql.exec("UPDATE receipt_records SET payment_path='CASH'");
    const response = await route.PATCH(request("PATCH", { ...body, expectedRevision: 0 }), context);
    assert.equal(response.status, 409); assert.equal(((await response.json()) as { code: string }).code, "receipt_revision_conflict");
  }
  const staleDelete = await route.DELETE(request("DELETE", { expectedRevision: 0 }), context);
  assert.equal(staleDelete.status, 409);
  assert.equal(((await staleDelete.json()) as { code: string }).code, "receipt_revision_conflict");
});

test("every receipt column and related writer invalidates; old/new relationship parents covered", () => {
  current = fixture();
  const columns = current.sql.prepare("PRAGMA table_info(receipt_records)").all().map((r: { name: string }) => r.name);
  const trigger = current.sql.prepare("SELECT sql FROM sqlite_master WHERE name='receipt_revision_update'").get().sql as string;
  for (const col of columns.filter((c: string) => c !== "revision")) assert.match(trigger, new RegExp(`\\b${col}\\b`));
  current.sql.exec(`INSERT INTO receipt_records
    (id,captured_at,captured_by,payment_path,status,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at)
    VALUES ('r2','t','a','UNKNOWN','captured','k2','s','image/jpeg',1,'t','t')`);
  current.sql.exec("INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('a','r1','A','t')");
  let revision = current.revision();
  current.sql.exec("UPDATE receipt_attendees SET receipt_id='r2'");
  assert.ok(current.revision() > revision);
  assert.ok(current.sql.prepare("SELECT revision FROM receipt_records WHERE id='r2'").get().revision > 0);
  current.sql.exec("INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,matched_receipt_id,raw_json,created_at) VALUES ('l','2026-11','2026-11-10','m',1,'r1','{}','t')");
  for (const change of ["UPDATE amex_statement_lines SET matched_receipt_id='r2'", "UPDATE receipt_records SET exported_month='2026-11'", "UPDATE receipt_records SET deleted_at='t'"]) {
    revision = current.revision(); current.sql.exec(change); assert.ok(current.revision() > revision);
  }
});

test("revision-only invalidation preserves seal authority across paths, lifecycle and correction/build states", () => {
  // 48 combinations inside one collected case; business values stay identical.
  for (const path of ["CASH", "DIGITAL", "UNKNOWN", "AMEX"]) {
    for (const status of ["captured", "reviewed", "exported", "archived"]) {
      for (const mode of ["claim", "finalized", "correction"]) {
        current = fixture();
        current.sql.prepare("UPDATE receipt_records SET payment_path=?, status=?, transaction_date='2026-11-10', export_statement_month='2026-11', exported_month='2026-11'").run(path,status);
        current.sql.prepare(`INSERT INTO receipt_exports
          (id,export_month,status,created_by,created_at,retention_until,legal_hold,export_revision,sealing_token,sealing_expires_at)
          VALUES ('e','2026-11',?,'a','t','t',1,1,?,?)`).run(mode === "claim" ? "draft" : "finalized", mode === "claim" ? "claim-token" : null, mode === "claim" ? Math.floor(Date.now()/1000)+600 : null);
        if (mode === "correction") current.sql.exec("INSERT INTO receipt_exports (id,export_month,status,created_by,created_at,export_revision) VALUES ('d','2026-11','draft','a','t',2)");
        const before = current.sql.prepare("SELECT * FROM receipt_records").get();
        current.sql.exec("UPDATE receipt_records SET revision=revision+1");
        const after = current.sql.prepare("SELECT * FROM receipt_records").get();
        assert.deepEqual({ ...after, revision: before.revision }, { ...before }, `${path}/${status}/${mode}`);
        assert.equal(after.revision, before.revision+1);
        current.sql.close();
      }
    }
  }
});

test("ack is the batch's committed revision, never another writer's later token", async () => {
  current = fixture();
  current.afterCommit(() => current.sql.exec("UPDATE receipt_records SET merchant='later writer'"));
  const response = await route.PATCH(request("PATCH", { expectedRevision: 0, merchant: "first writer" }), context);
  assert.equal(response.status, 200);
  const ack = await response.json() as { revision: number };
  assert.equal(ack.revision + 1, current.revision());
  const stale = await route.PATCH(request("PATCH", { expectedRevision: ack.revision, merchant: "overwrite" }), context);
  assert.equal(stale.status, 409);
});

test("D1 commit-before-error yields 500 and halts the queue; admitted Delete returns its exact token", async () => {
  current = fixture(); current.loseAck();
  const queue = new SaveQueue({ initialRevision: 0, url: "/r1", buildBody: () => ({ merchant: "committed" }), fetchImpl: async (_url, init) => route.PATCH(request("PATCH", JSON.parse(init.body as string)), context) });
  await assert.rejects(queue.save(), /uncertain/);
  assert.equal(current.sql.prepare("SELECT merchant FROM receipt_records").get().merchant, "committed");
  assert.ok(current.audits().length > 0);
  await assert.rejects(queue.save(), /uncertain/);
  current = fixture();
  const response = await route.DELETE(request("DELETE", { expectedRevision: 0 }), context);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { revision: number }).revision, current.revision());
  assert.equal(current.audits().length, 1);
});

test("file manifest and export-item direct writes invalidate the receipt aggregate", () => {
  current = fixture();
  const changes = [
    `INSERT INTO receipt_files (id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,file_size_bytes,sha256_hash,uploaded_by,uploaded_at,created_at,updated_at)
      VALUES ('f','receipt','r1','original','bucket','key','f.jpg','image/jpeg',1,'sha','a','t','t','t')`,
    "UPDATE receipt_files SET role='proof' WHERE id='f'",
    "DELETE FROM receipt_files WHERE id='f'",
    "INSERT INTO receipt_exports (id,export_month,status,created_by,created_at) VALUES ('e','2026-11','draft','a','t')",
    "INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at) VALUES ('i','e','receipt','r1','t')",
    "UPDATE receipt_export_items SET created_at='later' WHERE id='i'",
    "DELETE FROM receipt_export_items WHERE id='i'",
  ];
  for (const sql of changes) {
    const revision = current.revision(); current.sql.exec(sql);
    if (!sql.startsWith("INSERT INTO receipt_exports ")) assert.ok(current.revision() > revision, sql);
  }
});
