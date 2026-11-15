// Real Worker + PostalMime + shared writers/SQL + processor/manual route.
// Only platform bindings, Clerk, and the receipt-capture boundary are replaced.
import test, { mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { EmailReceiptIntake, CreateReceiptInput } from "@/lib/receipts/types";
// @ts-expect-error node:sqlite exists in the required Node 22 runtime.
import { DatabaseSync } from "node:sqlite";

const ENTRY = "2026-11-15T12:00:00.000Z";
const TRUST = "2026-11-15T12:00:01.000Z";
const migrations = readdirSync("db/receipts").filter(f => f.endsWith(".sql")).sort();
function database(upgrade = true) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys=ON");
  for (const f of migrations.filter(f => upgrade || f < "0045")) raw.exec(readFileSync(`db/receipts/${f}`, "utf8"));
  return raw;
}
let raw: ReturnType<typeof database>;
let beforeStatement: ((sql: string) => Promise<void>) | null;
let objects: Map<string, ArrayBuffer>;
let deleted: string[];
let captures: CreateReceiptInput[];
let failDelete = false;
let failSql: string | null = null;
function prepare(sql: string) {
  const make = (args: unknown[]) => ({
    sql, args,
    bind: (...values: unknown[]) => make(values),
    first: async () => { await beforeStatement?.(sql); return raw.prepare(sql).get(...args) ?? null; },
    all: async () => { await beforeStatement?.(sql); return { results: raw.prepare(sql).all(...args) }; },
    run: async () => {
      await beforeStatement?.(sql);
      if (failSql && sql.includes(failSql)) throw new Error("fixture SQL failure");
      return { success: true, meta: { changes: Number(raw.prepare(sql).run(...args).changes) } };
    },
  });
  return make([]);
}
const db = {
  prepare,
  async batch(statements: ReturnType<typeof prepare>[]) {
    raw.exec("BEGIN");
    try { const out = []; for (const s of statements) out.push(await s.run()); raw.exec("COMMIT"); return out; }
    catch (e) { raw.exec("ROLLBACK"); throw e; }
  },
} as unknown as D1Database;
const bucket = {
  async put(key: string, value: ArrayBuffer) { objects.set(key, value); },
  async delete(key: string) { if (failDelete) throw new Error("fixture R2 failure"); deleted.push(key); objects.delete(key); },
} as unknown as R2Bucket;
mock.module("@/lib/cloudflare-runtime", { namedExports: {
  getReceiptsDb: () => db, getReceiptsBucket: () => bucket, getReceiptsProcessorKey: () => "fixture-key",
} });
mock.module("@/lib/receipts/auth", { namedExports: { requireReceiptsActor: async () => "fixture-operator" } });
mock.module("@/lib/receipts/capture", { namedExports: {
  captureReceipt: async ({ record }: { record: CreateReceiptInput }) => {
    captures.push(record);
    const id = `receipt-${captures.length}`;
    raw.prepare(`INSERT INTO receipt_records(id,captured_at,captured_by,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at)
      VALUES (?,?,?,?,'hash','text/plain',1,?,?)`).run(id, ENTRY, "fixture", `receipts/${id}`, ENTRY, ENTRY);
    return { receiptId: id };
  },
} });
let worker: typeof import("../src/index").default;
let POST: typeof import("../../../app/api/receipts/inbox/[id]/promote/route").POST;
let recordIntake: typeof import("@/lib/receipts/email-intake").recordIntake;
let recordBlockedIntake: typeof import("@/lib/receipts/email-intake").recordBlockedIntake;
let listPendingIntake: typeof import("@/lib/receipts/email-intake").listPendingIntake;
let rejectIntake: typeof import("@/lib/receipts/email-intake").rejectIntake;
let listUnrecognizedSenders: typeof import("@/lib/receipts/sender-activity").listUnrecognizedSenders;
let getSenderControlsSnapshot: typeof import("@/lib/receipts/sender-activity").getSenderControlsSnapshot;
let parseIntakeTime: typeof import("@/lib/receipts/intake-time").parseIntakeTime;
let intakeJulianSql: typeof import("@/lib/receipts/intake-time").intakeJulianSql;
let intakeActivityLabel: typeof import("@/lib/receipts/intake-time").intakeActivityLabel;
let CLEANUP_CRON: string;
before(async () => {
  worker = (await import("../src/index")).default;
  ({ POST } = await import("../../../app/api/receipts/inbox/[id]/promote/route"));
  ({ recordIntake, recordBlockedIntake, listPendingIntake, rejectIntake } = await import("@/lib/receipts/email-intake"));
  ({ listUnrecognizedSenders, getSenderControlsSnapshot } = await import("@/lib/receipts/sender-activity"));
  ({ parseIntakeTime, intakeJulianSql, intakeActivityLabel } = await import("@/lib/receipts/intake-time"));
  ({ CLEANUP_CRON } = await import("@/lib/receipts/pipeline-digest"));
});
type Env = Parameters<typeof worker.email>[1];
const env = { RECEIPTS_DB: db, RECEIPTS_BUCKET: bucket } as Env;
function context() {
  const tasks: Promise<unknown>[] = [];
  return { tasks, ctx: { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext };
}
function rows(): EmailReceiptIntake[] { return raw.prepare("SELECT * FROM email_receipt_intake ORDER BY rowid").all(); }
function insert(overrides: Partial<EmailReceiptIntake> = {}) {
  const row = { id: crypto.randomUUID(), received_at: "2099-01-01T00:00:00Z", arrived_at: ENTRY, created_at: ENTRY,
    from_address: "fixture@example.invalid", spf_pass: 1, dkim_pass: 1, body_text: "Receipt body", ...overrides };
  const entries = Object.entries(row);
  raw.prepare(`INSERT INTO email_receipt_intake (${entries.map(([k]) => k).join(",")}) VALUES (${entries.map(() => "?").join(",")})`).run(...entries.map(([,v]) => v));
  if (row.attachment_r2_key) objects.set(row.attachment_r2_key, new ArrayBuffer(1));
  return row.id;
}
async function ingest(date: string | null, attachment = false, options: { blocked?: boolean; rawSize?: number; failRead?: boolean } = {}) {
  const headers = new Headers({ from: "fixture@example.invalid", subject: "Receipt", "authentication-results": "mx; spf=pass; dkim=pass" });
  if (date !== null) headers.set("date", date);
  const mime = ["From: fixture@example.invalid", "To: inbox@example.invalid", "Subject: Receipt"];
  if (date !== null) mime.push(`Date: ${date}`);
  if (attachment) mime.push('MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="fixture"', '',
    '--fixture', 'Content-Type: text/plain', '', 'Receipt body',
    '--fixture', 'Content-Type: image/jpeg', 'Content-Disposition: attachment; filename="receipt.jpg"', 'Content-Transfer-Encoding: base64', '', '/9j/2Q==',
    '--fixture', 'Content-Type: application/zip', 'Content-Disposition: attachment; filename="rejected.zip"', '', 'zip', '--fixture--', '');
  else mime.push("Content-Type: text/plain", "", "Receipt body");
  const bytes = new TextEncoder().encode(mime.join("\r\n"));
  let reads = 0;
  const message = { from: "fixture@example.invalid", to: "inbox@example.invalid", headers, rawSize: options.rawSize ?? bytes.length,
    get raw() { reads++; if (options.blocked || options.failRead) throw new Error("raw access forbidden");
      return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }); },
  } as ForwardableEmailMessage;
  const c = context(); await worker.email(message, env, c.ctx); await Promise.all(c.tasks);
  return reads;
}
async function cleanup() {
  const c = context();
  await worker.scheduled({ cron: CLEANUP_CRON, scheduledTime: Date.now() } as ScheduledController, env, c.ctx);
  await Promise.all(c.tasks);
}
function trust(created = TRUST) { raw.prepare("INSERT INTO trusted_intake_senders VALUES ('fixture@example.invalid','operator',?)").run(created); }
async function promote(id: string, processor = true) {
  return POST(new Request("http://local.invalid/promote", { method: "POST", headers: processor ? { "x-receipts-processor-key": "fixture-key" } : {} }), { params: Promise.resolve({ id }) });
}
function dates(row: EmailReceiptIntake) { return [row.arrived_at, row.created_at, row.received_at, row.raw_headers_json]; }
beforeEach(() => {
  raw = database(); beforeStatement = null; objects = new Map(); deleted = []; captures = []; failDelete = false; failSql = null;
  mock.timers.enable({ apis: ["Date"], now: Date.parse(ENTRY) });
  mock.method(console, "log", () => {}); mock.method(console, "error", () => {}); mock.method(console, "warn", () => {});
  mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
});
afterEach(() => { raw.close(); mock.timers.reset(); mock.restoreAll(); });

for (const date of ["Thu, 01 Oct 2026 12:00:00 +0000", "Sun, 15 Nov 2099 12:00:00 +0000", "Sun, 15 Nov 2026 21:00:00 +0900", null, "", "not-a-date"]) {
  test(`actual MIME capture preserves entry arrival and sender evidence: ${JSON.stringify(date)}`, async () => {
    await ingest(date, true);
    const result = rows(); assert.equal(result.length, 2);
    for (const row of result) {
      assert.equal(row.arrived_at, ENTRY); assert.equal(row.created_at, ENTRY);
      assert.equal(row.received_at, date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : ENTRY);
      assert.equal(JSON.parse(row.raw_headers_json!).date ?? null, date);
      assert.equal(row.body_text?.trim(), "Receipt body");
    }
    assert.equal(objects.size, 1); assert.match(result[0].attachment_r2_key!, /^receipts-intake\/2026\/11\//);
    assert.deepEqual([...new Uint8Array(objects.get(result[0].attachment_r2_key!)!)], [255,216,255,217]);
    assert.equal(result[1].attachment_r2_key, null); assert.match(result[1].reject_reason!, /type not allowed/);
    await ingest(date); assert.equal(rows()[2].arrived_at, ENTRY); assert.equal(rows()[2].attachment_filename, null);
  });
}

test("blocked delivery captures entry before lookup, metadata only, even oversized; audit remains atomic", async () => {
  raw.prepare("INSERT INTO blocked_intake_senders VALUES ('fixture@example.invalid','operator',?)").run(ENTRY);
  beforeStatement = async (sql) => { if (sql.includes("SELECT") && sql.includes("blocked_intake_senders")) mock.timers.setTime(Date.parse(TRUST)); };
  assert.equal(await ingest("not-a-date", true, { blocked: true, rawSize: 20 * 1024 * 1024 }), 0);
  const [row] = rows(); assert.equal(row.arrived_at, ENTRY); assert.equal(row.created_at, TRUST); assert.equal(row.received_at, ENTRY);
  assert.equal(row.raw_headers_json, null); assert.equal(row.body_text, null); assert.equal(row.attachment_filename, null); assert.equal(row.status, "rejected");
  assert.equal(objects.size, 0); assert.equal(raw.prepare("SELECT COUNT(*) n FROM receipt_audit_log").get().n, 1);
  failSql = "INSERT INTO receipt_audit_log";
  await ingest(null, false, { blocked: true }); assert.equal(rows().length, 1);
});

test("size ceiling and raw-read failure retain existing no-capture behavior", async () => {
  assert.equal(await ingest(null, true, { rawSize: 20 * 1024 * 1024 }), 0); assert.equal(rows().length, 0);
  assert.equal(await ingest(null, false, { failRead: true }), 1); assert.equal(rows().length, 0);
});

test("entry before trust cannot be admitted when lookup, MIME processing and persistence finish after trust", async () => {
  trust();
  beforeStatement = async (sql) => { if (sql.includes("blocked_intake_senders")) { await Promise.resolve(); mock.timers.setTime(Date.parse(TRUST) + 1000); } };
  await ingest("Sun, 15 Nov 2099 12:00:00 +0000");
  assert.equal(rows()[0].arrived_at, ENTRY); assert.equal(rows()[0].created_at, "2026-11-15T12:00:02.000Z");
  assert.equal((await promote(rows()[0].id)).status, 409); assert.equal(captures.length, 0);
});

test("raw stream delayed across trust keeps the synchronous entry clock", async () => {
  trust(); const c = context();
  const headers = new Headers({from: "fixture@example.invalid", "authentication-results": "mx; spf=pass; dkim=pass"});
  const bytes = new TextEncoder().encode("From: fixture@example.invalid\r\nDate: invalid\r\n\r\nReceipt");
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { await Promise.resolve(); mock.timers.setTime(Date.parse(TRUST) + 1000); controller.enqueue(bytes); controller.close(); } });
  await worker.email({from: "fixture@example.invalid", headers, rawSize: bytes.length, raw: stream} as ForwardableEmailMessage, env, c.ctx); await Promise.all(c.tasks);
  assert.equal(rows()[0].arrived_at, ENTRY); assert.equal((await promote(rows()[0].id)).status, 409);
});

test("both writer boundaries reject invalid/missing/future operational input before R2/SQL; offsets normalize", async () => {
  const input = { receivedAt: ENTRY, fromAddress: "fixture@example.invalid", toAddress: null, subject: null, spfPass: true, dkimPass: true, rawHeadersJson: null,
    bodyText: "body", bodyHtml: null, bodyTruncated: false, attachments: [{filename: "r.pdf", contentType: "application/pdf", sizeBytes: 1, data: new ArrayBuffer(1)}] };
  for (const arrivedAt of [undefined, "", "invalid", "2026-02-30T00:00:00Z", "2026-11-15T12:00:00", "2099-01-01T00:00:00Z"]) {
    await assert.rejects(recordIntake(db, bucket, { ...input, arrivedAt: arrivedAt as string }), /arrivedAt/);
    await assert.rejects(recordBlockedIntake(db, { ...input, arrivedAt: arrivedAt as string, blockedSenderEmail: "fixture@example.invalid" }), /arrivedAt/);
  }
  assert.equal(objects.size, 0); assert.equal(rows().length, 0);
  await recordIntake(db, bucket, { ...input, arrivedAt: "2026-11-15T21:00:00+09:00" }); assert.equal(rows()[0].arrived_at, ENTRY);
});

test("cleanup uses actual operational instants, strict 30 days and legacy-only fallback; preserves evidence", async () => {
  const cutoff = Date.parse(ENTRY) - 30 * 86400000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const cases: [string, Partial<EmailReceiptIntake>, boolean][] = [
    ["fresh-old-header", {received_at: "2001-01-01T00:00:00Z"}, false],
    ["old-future-header", {arrived_at: iso(cutoff - 1)}, true],
    ["equal", {arrived_at: iso(cutoff)}, false], ["before", {arrived_at: iso(cutoff + 1)}, false],
    ["offset-old", {arrived_at: "2026-10-16T20:59:59.999+09:00"}, true],
    ["offset-equal", {arrived_at: "2026-10-16T21:00:00.000+09:00"}, false],
    ["legacy-old", {arrived_at: null, created_at: iso(cutoff - 1)}, true],
    ["legacy-fresh", {arrived_at: null, received_at: "2001-01-01T00:00:00Z"}, false],
    ["legacy-bad", {arrived_at: null, created_at: "invalid"}, false],
    ["legacy-empty", {arrived_at: null, created_at: ""}, false],
    ["legacy-future", {arrived_at: null, created_at: "2099-01-01T00:00:00Z"}, false],
    ["corrupt", {arrived_at: "invalid", created_at: iso(cutoff - 1)}, false],
    ["empty", {arrived_at: "", created_at: iso(cutoff - 1)}, false],
    ["no-zone", {arrived_at: "2020-01-01T00:00:00"}, false],
    ["calendar-rollover", {arrived_at: "2020-02-30T00:00:00Z"}, false],
    ["future", {arrived_at: "2099-01-01T00:00:00Z", created_at: iso(cutoff - 1)}, false],
    ["rejected", {status: "rejected", reject_reason: "operator reason", arrived_at: "invalid"}, true],
    ["promoted", {status: "promoted", arrived_at: iso(cutoff - 1)}, false],
    ["body-only", {attachment_r2_key: null, arrived_at: iso(cutoff - 1)}, false],
    ["existing-reason", {reject_reason: "type issue", arrived_at: iso(cutoff - 1)}, true],
  ];
  for (const [id, over] of cases) insert({id, attachment_r2_key: `intake/${id}`, attachment_filename: "receipt.pdf", raw_headers_json: '{"date":"sender evidence"}', ...over});
  const before = rows(); await cleanup();
  for (const [id, , expires] of cases) {
    const row = rows().find(r => r.id === id)!; const original = before.find(r => r.id === id)!;
    assert.equal(deleted.includes(`intake/${id}`), expires, id); assert.equal(row.attachment_r2_key, expires ? null : original.attachment_r2_key, id);
    assert.deepEqual(dates(row), dates(original)); assert.equal(row.body_text, original.body_text); assert.equal(row.status, original.status);
    assert.equal(row.reject_reason, expires && original.status === "pending_triage" && !original.reject_reason ? "attachment expired — R2 object deleted after 30 days pending" : original.reject_reason);
  }
});

test("cleanup cap 200 follows trusted instant order rather than sender strings", async () => {
  for (let i = 204; i >= 0; i--) insert({id: `r${i}`, arrived_at: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000).toISOString(), received_at: new Date(Date.parse(ENTRY) - i * 1000).toISOString(), attachment_r2_key: `key${i}`});
  await cleanup(); assert.deepEqual(deleted, Array.from({length: 200}, (_,i) => `key${i}`));
  assert.equal(rows().filter(r => r.attachment_r2_key).length, 5);
});

test("cleanup keeps best-effort delete and SQL failure behavior", async () => {
  insert({id: "r", arrived_at: "2020-01-01T00:00:00Z", attachment_r2_key: "key"}); failDelete = true;
  await cleanup(); assert.equal(rows()[0].attachment_r2_key, null); assert.equal(objects.has("key"), true);
  insert({id: "s", arrived_at: "2020-01-01T00:00:00Z", attachment_r2_key: "key2"}); failDelete = false; failSql = "UPDATE email_receipt_intake";
  await cleanup(); assert.equal(rows()[1].attachment_r2_key, "key2"); assert.equal(objects.has("key2"), false);
});

test("nullable forward migration preserves populated legacy rows, receipt/seal bytes and stored keys", () => {
  raw.close(); raw = database(false);
  raw.exec(`INSERT INTO receipt_records(id,captured_at,captured_by,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at) VALUES ('r','old','a','existing/object','sha','image/png',1,'old','old');
    INSERT INTO receipt_exports(id,export_month,status,created_by,created_at,retention_until,legal_hold) VALUES ('e','2026-01','draft','a','old','2036',1);
    INSERT INTO receipt_export_items(id,export_id,item_type,item_id,created_at) VALUES ('i','e','receipt','r','old');
    UPDATE receipt_exports SET status='finalized' WHERE id='e';
    INSERT INTO email_receipt_intake(id,received_at,created_at,from_address,attachment_r2_key,raw_headers_json) VALUES ('legacy','2099','2020-01-01T00:00:00Z','a@b.test','unchanged/key','{"date":"2099"}');`);
  const receiptBefore = raw.prepare("SELECT * FROM receipt_records").all(); const exportsBefore = raw.prepare("SELECT * FROM receipt_exports").all();
  const legacy = raw.prepare("SELECT * FROM email_receipt_intake").get();
  raw.exec(readFileSync("db/receipts/0045_intake_arrival.sql", "utf8"));
  const { arrived_at, ...after } = rows()[0]; assert.equal(arrived_at, null); assert.deepEqual(after, { ...legacy });
  assert.deepEqual(raw.prepare("SELECT * FROM receipt_records").all(), receiptBefore); assert.deepEqual(raw.prepare("SELECT * FROM receipt_exports").all(), exportsBefore);
  assert.equal(raw.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

test("legacy unknown arrival is refused automatically but manual body and attachment promotion preserve dates and transaction authority", async () => {
  trust("2020-01-01T00:00:00Z");
  for (const attachment of [false, true]) {
    const id = insert({arrived_at: null, attachment_r2_key: attachment ? "legacy/key" : null, attachment_filename: attachment ? "r.pdf" : null});
    const before = dates(rows().find(r => r.id === id)!);
    assert.equal((await promote(id)).status, 409); assert.equal((await promote(id, false)).status, 200);
    assert.deepEqual(dates(rows().find(r => r.id === id)!), before);
    assert.equal(captures.at(-1)?.transactionDate, undefined); assert.equal("retentionUntil" in captures.at(-1)!, false);
    // The duplicate-repoint SQL intentionally only changes the relationship.
    const repointSql = /db\.prepare\(`(UPDATE email_receipt_intake SET promoted_receipt_id = \? WHERE promoted_receipt_id = \?)`\)/.exec(readFileSync("lib/receipts/duplicate-purge.ts", "utf8"))?.[1];
    assert.ok(repointSql);
    raw.prepare(repointSql).run("receipt-1", `receipt-${captures.length}`);
    assert.deepEqual(dates(rows().find(r => r.id === id)!), before);
  }
  const id = insert({arrived_at: null}); const before = dates(rows().find(r => r.id === id)!);
  await rejectIntake(db, id, "not needed", "fixture-operator"); assert.deepEqual(dates(rows().find(r => r.id === id)!), before);
});

test("inbox and sender activity order by normalized arrival/legacy processing time; corrupt dates stay visible", async () => {
  insert({id: "old", from_address: "old@example.invalid", arrived_at: "2020-01-01T00:00:00Z", received_at: "2099-01-01T00:00:00Z"});
  insert({id: "legacy", from_address: "legacy@example.invalid", arrived_at: null, created_at: "2020-03-01T00:00:00Z", received_at: "1900-01-01T00:00:00Z"});
  insert({id: "new", from_address: "new@example.invalid", arrived_at: "2020-04-01T09:00:00+09:00"});
  insert({id: "bad", from_address: "bad@example.invalid", arrived_at: "invalid", created_at: "2099"});
  insert({id: "old-later", from_address: "old@example.invalid", arrived_at: "2020-02-01T09:00:00+09:00", received_at: "1900-01-01T00:00:00Z"});
  assert.deepEqual((await listPendingIntake(db)).map(r => r.id), ["new", "legacy", "old-later", "old", "bad"]);
  const activity = await listUnrecognizedSenders(db); assert.deepEqual(activity.map(r => r.from_address), ["new@example.invalid", "legacy@example.invalid", "old@example.invalid", "bad@example.invalid"]);
  assert.equal(activity[0].latest_received, "2020-04-01T00:00:00.000Z"); assert.equal(activity[1].legacy_count, 1);
  assert.equal(activity[2].first_received, "2020-01-01T00:00:00.000Z");
  assert.equal(activity[2].latest_received, "2020-02-01T00:00:00.000Z");
  assert.equal(activity[2].total, 2);
  assert.equal(activity[3].latest_received, null); assert.equal(activity[3].unavailable_count, 1);
  assert.match(intakeActivityLabel(rows()[1]), /Legacy processing time:/); assert.equal(intakeActivityLabel(rows()[3]), "Worker arrival unavailable");
  raw.prepare("INSERT INTO blocked_intake_senders VALUES ('new@example.invalid','operator',?)").run(ENTRY);
  raw.prepare("UPDATE email_receipt_intake SET blocked_sender_email='new@example.invalid' WHERE id IN ('new','bad')").run();
  const snap = await getSenderControlsSnapshot(db); assert.equal(snap.blocked[0].latest_blocked_delivery, "2020-04-01T00:00:00.000Z"); assert.equal(snap.blocked[0].unavailable_count, 1);
});

const timeCases = JSON.parse(readFileSync("tests/fixtures/intake-arrival-times.json", "utf8")) as {name: string; arrival: string | null; trust: string; eligible: boolean; valid: boolean}[];
for (const c of timeCases) test(`TS processor and SQLite parse parity: ${c.name}`, async () => {
  mock.timers.setTime(Date.parse(TRUST) + 1000);
  trust(c.trust); const id = insert({arrived_at: c.arrival});
  assert.equal(parseIntakeTime(c.arrival) !== null, c.valid);
  const parsed = raw.prepare(`WITH t(v) AS (VALUES (?)) SELECT ${intakeJulianSql("v")} AS instant FROM t`).get(c.arrival);
  assert.equal(parsed.instant !== null, c.valid);
  assert.equal((await promote(id)).status, c.eligible ? 200 : 409);
});

for (const [name, over] of Object.entries({
  "current attachment": { attachment_r2_key: "key" },
  "expired original attachment": { attachment_filename: "expired.pdf" },
  "SPF fail": { spf_pass: 0 }, "DKIM fail": { dkim_pass: 0 },
  "no body": { body_text: null }, "rejected": { status: "rejected" },
  "promoted": { status: "promoted" }, "untrusted": { from_address: "stranger@example.invalid" },
} satisfies Record<string, Partial<EmailReceiptIntake>>)) {
  test(`actual processor route preserves ${name} veto`, async () => {
    trust(ENTRY); const id = insert(over);
    assert.equal((await promote(id)).status, 409); assert.equal(captures.length, 0);
  });
}
test("current blocked policy wins even after an earlier eligible selection", async () => {
  trust(ENTRY); const id = insert();
  raw.prepare("INSERT INTO blocked_intake_senders VALUES ('fixture@example.invalid','operator',?)").run(ENTRY);
  assert.equal((await promote(id)).status, 409); assert.equal(captures.length, 0);
});
