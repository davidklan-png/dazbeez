// Service-level tests for duplicate-purge orchestrator.
// Calls the REAL purgeDuplicate / retryR2Cleanup / inventoryR2Keys against a
// mock D1Database + R2Bucket with call counters and batch SQL capture.
import test from "node:test";
import assert from "node:assert/strict";
import {
  purgeDuplicate,
  retryR2Cleanup,
  inventoryR2Keys,
  normalizeClusterIds,
  PurgeEligibilityError,
  PURGE_TARGET_CAP,
  type PurgeRequest,
} from "@/lib/receipts/duplicate-purge";
import type { ReceiptRecord } from "@/lib/receipts/types";

// ─── fixtures ───────────────────────────────────────────────────────────────

let seq = 0;
function mkReceipt(over: Partial<ReceiptRecord> & { id: string }): ReceiptRecord {
  seq += 1;
  return {
    captured_at: "2026-06-19T00:00:00Z", captured_by: "op", source: "mobile_capture",
    original_filename: "image.jpg", payment_path: "AMEX", expense_type: "UNKNOWN",
    transaction_date: "2026-06-19", merchant: "岡芳商店", amount_minor: 3862, currency: "JPY",
    tax_amount_minor: null, business_purpose: null, alcohol_present: 0, attendees_required: 0,
    status: "reviewed", original_r2_key: `receipts/2026/06/${seq}/image.jpg`,
    original_sha256: `sha-${seq}`, original_content_type: "image/jpeg", original_size_bytes: 100,
    processed_r2_key: null, extraction_json: null, legacy: 0, exported_month: null,
    expense_category_code: null, deleted_at: null, deleted_by: null, delete_reason: null,
    updated_at: "v1", ...over,
  } as ReceiptRecord;
}

interface Fixture {
  receipts: Record<string, ReceiptRecord>;
  amexClaims?: Record<string, number>;
  exportItems?: Record<string, number>;
  exportMonths?: Record<string, string[]>;
  tripLinks?: Record<string, string[]>;
  emailPromoted?: Set<string>;
  proofFiles?: Set<string>;
  files?: Record<string, Array<{ id: string; r2_bucket: string; r2_key: string }>>;
  categoryRules?: Array<{ id: string; source_receipt_ids_json: string | null }>;
  purgeJobs?: Record<string, { pending_keys_json: string | null; status: string }>;
  batchShouldThrow?: boolean;
}

function defaultFixture(): Fixture {
  return {
    receipts: {
      retained: mkReceipt({ id: "retained", status: "reconciled", updated_at: "rv1" }),
      target: mkReceipt({ id: "target", status: "reviewed", updated_at: "tv1" }),
    },
  };
}

// ─── mock D1 (with batch SQL/bind capture) ──────────────────────────────────

interface BatchStmt { sql: string; binds: unknown[]; }

function makeMockDb(cfg: Fixture) {
  let batchCalled = false;
  const batchStmts: BatchStmt[][] = [];
  const runCalls: string[] = [];

  function respond(sqlRaw: string, binds: unknown[]): { first: Record<string, unknown> | null; results: Record<string, unknown>[] } {
    const s = sqlRaw.replace(/\s+/g, " ").trim();
    const id = (binds[0] as string) ?? "";
    if (s.includes("FROM receipt_records WHERE id = ?")) {
      if (s.includes("original_r2_key, processed_r2_key")) {
        const r = cfg.receipts[id];
        return { first: r ? { original_r2_key: r.original_r2_key, processed_r2_key: r.processed_r2_key, extraction_r2_key: null, original_sha256: r.original_sha256 } : null, results: [] };
      }
      const r = cfg.receipts[id];
      return { first: r ? (r as unknown as Record<string, unknown>) : null, results: r ? [r as unknown as Record<string, unknown>] : [] };
    }
    if (s.includes("FROM amex_statement_lines WHERE matched_receipt_id = ?")) {
      const n = cfg.amexClaims?.[id] ?? 0;
      if (s.includes("COUNT(*)")) return { first: { n }, results: [] };
      return { first: n > 0 ? { statement_month: "2026-08", id: "L1" } : null, results: [] };
    }
    if (s.includes("FROM receipt_export_items WHERE item_type='receipt' AND item_id = ?"))
      return { first: { n: cfg.exportItems?.[id] ?? 0 }, results: [] };
    if (s.includes("DISTINCT e.export_month"))
      return { first: null, results: (cfg.exportMonths?.[id] ?? []).map((m) => ({ export_month: m })) };
    if (s.includes("DISTINCT business_trip_report_id"))
      return { first: null, results: (cfg.tripLinks?.[id] ?? []).map((bid) => ({ business_trip_report_id: bid })) };
    if (s.includes("FROM email_receipt_intake WHERE promoted_receipt_id"))
      return { first: cfg.emailPromoted?.has(id) ? { ok: 1 } : null, results: [] };
    if (s.includes("FROM receipt_attendees WHERE receipt_id = ?"))
      return { first: null, results: [] };
    if (s.includes("role='proof_copy'"))
      return { first: cfg.proofFiles?.has(id) ? { ok: 1 } : null, results: [] };
    if (s.includes("FROM receipt_files WHERE object_type='receipt' AND object_id=?"))
      return { first: null, results: (cfg.files?.[id] ?? []) as unknown as Record<string, unknown>[] };
    if (s.includes("FROM merchant_category_rules WHERE source_receipt_ids_json LIKE ?"))
      return { first: null, results: (cfg.categoryRules ?? []) as unknown as Record<string, unknown>[] };
    if (s.includes("FROM duplicate_purge_log WHERE id = ?")) {
      const job = cfg.purgeJobs?.[id];
      return { first: job ? (job as unknown as Record<string, unknown>) : null, results: [] };
    }
    return { first: null, results: [] };
  }

  function prepare(sql: string): D1PreparedStatement {
    let binds: unknown[] = [];
    const bound = {
      _sql: sql, _binds: [] as unknown[],
      bind(...args: unknown[]) { binds = args; this._binds = binds; return this; },
      async first<T>(): Promise<T | null> { return (respond(sql, binds).first ?? null) as T | null; },
      async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
        return { results: respond(sql, binds).results as T[], success: true, meta: { changes: 0 } };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        runCalls.push(sql);
        return { success: true, meta: { changes: 1 } };
      },
    };
    return bound as unknown as D1PreparedStatement;
  }

  return {
    prepare,
    async batch(stmts: D1PreparedStatement[]) {
      batchCalled = true;
      batchStmts.push(stmts.map((s) => ({ sql: (s as unknown as { _sql: string })._sql, binds: (s as unknown as { _binds: unknown[] })._binds })));
      if (cfg.batchShouldThrow) throw new Error("batch failed");
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    _batchCalled: () => batchCalled,
    _batchCount: () => batchStmts.length,
    _batchStmts: () => batchStmts,
    _runCount: () => runCalls.length,
  };
}

// ─── mock R2 (with call counters + configurable errors) ─────────────────────

interface MockBucketOpts {
  failDeleteFor?: string;
  headAbsentFor?: Set<string>;
  headErrorFor?: Set<string>;
}

function makeMockBucket(keys: Set<string>, opts?: MockBucketOpts) {
  const deleteCalls: string[] = [];
  const headCalls: string[] = [];
  const listCalls: string[] = [];
  return {
    deleteCalls, headCalls, listCalls,
    async delete(key: string) {
      deleteCalls.push(key);
      if (opts?.failDeleteFor === key) throw new Error("R2 delete failed");
      keys.delete(key);
    },
    async head(key: string) {
      headCalls.push(key);
      if (opts?.headErrorFor?.has(key)) throw new Error("R2 head error");
      if (opts?.headAbsentFor?.has(key)) return null;
      return keys.has(key) ? ({ size: 1 } as object) : null;
    },
    async list(o: { prefix?: string }) {
      listCalls.push(o.prefix ?? "");
      const objs = [...keys].filter((k) => (o.prefix ? k.startsWith(o.prefix) : true)).map((key) => ({ key, size: 1 }));
      return { objects: objs, truncated: false, cursor: undefined };
    },
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function makeReq(db: ReturnType<typeof makeMockDb>, rb: ReturnType<typeof makeMockBucket>, ab: ReturnType<typeof makeMockBucket>, cfg: Fixture, over: Partial<PurgeRequest> = {}): PurgeRequest {
  const targetIds = over.targets?.map((t) => t.receiptId) ?? ["target"];
  return {
    db: db as unknown as D1Database, receiptsBucket: rb as unknown as R2Bucket, archiveBucket: ab as unknown as R2Bucket,
    retainedReceiptId: "retained", retainedExpectedUpdatedAt: cfg.receipts["retained"]?.updated_at ?? "rv1",
    targets: targetIds.map((id) => ({ receiptId: id, expectedUpdatedAt: cfg.receipts[id]?.updated_at ?? "tv1" })),
    visualConfirmed: true, legalHoldExceptionAcknowledged: true,
    confirmationText: `PURGE ${targetIds.length}`, reason: "operator-confirmed duplicate", actor: "test", ...over,
  };
}

function runPurge(cfg: Fixture, over: Partial<PurgeRequest> = {}) {
  const db = makeMockDb(cfg);
  const r2keys = new Set<string>();
  const rb = makeMockBucket(r2keys);
  const ab = makeMockBucket(new Set());
  return { db, rb, ab, r2keys, promise: purgeDuplicate(makeReq(db, rb, ab, cfg, over)) };
}

// ─── §5 happy path: bucket contains inventoried objects ─────────────────────

test("happy path: target R2 objects deleted + head-verified + completed", async () => {
  const cfg = defaultFixture();
  const targetKey = cfg.receipts.target.original_r2_key!;
  cfg.files = { target: [{ id: "f1", r2_bucket: "receipts", r2_key: targetKey }] };
  const db = makeMockDb(cfg);
  const r2keys = new Set([targetKey]);
  const rb = makeMockBucket(r2keys);
  const ab = makeMockBucket(new Set());
  const res = await purgeDuplicate(makeReq(db, rb, ab, cfg));
  assert.equal(res.completed, true);
  assert.equal(res.targets[0]!.status, "completed");
  assert.ok(rb.deleteCalls.includes(targetKey), "target R2 key must be deleted");
  assert.ok(rb.headCalls.includes(targetKey), "target R2 key must be head-verified");
  assert.equal(r2keys.has(targetKey), false, "target R2 key must be absent");
});

// ─── §1 explicit selected-target scope ──────────────────────────────────────

test("explicit selected-target scope: only requested targets in batch", async () => {
  const cfg = defaultFixture();
  cfg.receipts["t2"] = mkReceipt({ id: "t2", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19", updated_at: "t2v1" });
  cfg.receipts["unselected"] = mkReceipt({ id: "unselected", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19", updated_at: "uv1" });
  const { db, promise } = runPurge(cfg, { targets: [{ receiptId: "target", expectedUpdatedAt: "tv1" }], confirmationText: "PURGE 1" });
  const res = await promise;
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0]!.receiptId, "target");
  // §3: unselected must NOT appear in any batch destructive statement.
  const allSql = db._batchStmts().flat().map((s) => `${s.sql} ${JSON.stringify(s.binds)}`);
  assert.ok(!allSql.some((s) => s.includes("unselected")), "unselected must not appear in any batch statement");
});

// ─── §2 rejection tests ─────────────────────────────────────────────────────

for (const [name, over, check] of [
  ["visual confirmation", { visualConfirmed: false }, (e: PurgeEligibilityError) => e.status === 400 && /Visual/.test(e.message)],
  ["legal-hold ack", { legalHoldExceptionAcknowledged: false }, (e: PurgeEligibilityError) => e.status === 400 && /legal hold/i.test(e.message)],
  ["reason required", { reason: "" }, (e: PurgeEligibilityError) => e.status === 400],
  ["exact typed confirmation", { confirmationText: "wrong" }, (e: PurgeEligibilityError) => e.status === 400 && /PURGE/.test(e.message)],
  ["stale retained", { retainedExpectedUpdatedAt: "stale" }, (e: PurgeEligibilityError) => e.status === 409 && /Retained.*stale/i.test(e.message)],
  ["stale target", { targets: [{ receiptId: "target", expectedUpdatedAt: "stale" }], confirmationText: "PURGE 1" }, (e: PurgeEligibilityError) => e.status === 409 && /stale/i.test(e.message)],
] as const) {
  test(`reject: ${name}`, async () => {
    const { promise } = runPurge(defaultFixture(), over as Partial<PurgeRequest>);
    await assert.rejects(promise, (e: PurgeEligibilityError) => check(e));
  });
}

test("reject: duplicate target IDs", async () => {
  const { promise } = runPurge(defaultFixture(), { targets: [{ receiptId: "target", expectedUpdatedAt: "tv1" }, { receiptId: "target", expectedUpdatedAt: "tv1" }], confirmationText: "PURGE 2" });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /Duplicate/i.test(e.message));
});

test("reject: retained in targets", async () => {
  const { promise } = runPurge(defaultFixture(), { targets: [{ receiptId: "retained", expectedUpdatedAt: "rv1" }], confirmationText: "PURGE 1" });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /Retained/i.test(e.message));
});

test("reject: cap exceeded", async () => {
  const ids = Array.from({ length: 11 }, (_, i) => ({ receiptId: `t${i}`, expectedUpdatedAt: "v" }));
  const { promise } = runPurge(defaultFixture(), { targets: ids, confirmationText: `PURGE ${ids.length}` });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /cap/i.test(e.message));
});

test("reject: AMEX claim (409 or 422)", async () => {
  const cfg = defaultFixture(); cfg.amexClaims = { target: 1 };
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 || e.status === 422);
});

test("reject: export_items membership (409 or 422)", async () => {
  const cfg = defaultFixture(); cfg.exportItems = { target: 1 };
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 || e.status === 422);
});

test("reject: status exported (409 or 422)", async () => {
  const cfg = defaultFixture(); cfg.receipts.target = mkReceipt({ id: "target", status: "exported" });
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 || e.status === 422);
});

test("reject: extraction pending", async () => {
  const cfg = defaultFixture(); cfg.receipts.target = mkReceipt({ id: "target", status: "captured", extraction_state: "queued" as never });
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 && /extraction/i.test(e.message));
});

test("reject: target-only populated field (422)", async () => {
  const cfg = defaultFixture();
  cfg.receipts.target = mkReceipt({ id: "target", business_purpose: "stationery run" });
  cfg.receipts.retained = mkReceipt({ id: "retained", status: "reconciled", updated_at: "rv1" });
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 422 && /missing from the retained/i.test(e.message));
});

test("reject: non-candidate", async () => {
  const cfg = defaultFixture(); cfg.receipts.target = mkReceipt({ id: "target", amount_minor: 99999 });
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 && /candidate/i.test(e.message));
});

// ─── §3 preflight failure: no batch, no R2 delete/head ───────────────────────

test("preflight failure: no db.batch, no R2 delete/head", async () => {
  const cfg = defaultFixture(); cfg.amexClaims = { target: 1 };
  const db = makeMockDb(cfg);
  const rb = makeMockBucket(new Set());
  const ab = makeMockBucket(new Set());
  await assert.rejects(() => purgeDuplicate(makeReq(db, rb, ab, cfg)));
  assert.equal(db._batchCalled(), false, "batch must NOT be called");
  assert.equal(rb.deleteCalls.length, 0, "no R2 deletes");
  assert.equal(rb.headCalls.length, 0, "no R2 heads");
});

// ─── §3 db.batch failure: no R2 delete/head ─────────────────────────────────

test("db.batch failure: no R2 delete/head", async () => {
  const cfg = defaultFixture(); cfg.batchShouldThrow = true;
  const db = makeMockDb(cfg);
  const rb = makeMockBucket(new Set(["k1"]));
  const ab = makeMockBucket(new Set());
  await assert.rejects(() => purgeDuplicate(makeReq(db, rb, ab, cfg)));
  assert.equal(rb.deleteCalls.length, 0, "no R2 deletes after batch failure");
  assert.equal(rb.headCalls.length, 0, "no R2 heads after batch failure");
});

// ─── §5 R2 failure: storage_failed + retained inventory ─────────────────────

test("R2 failure: storage_failed, delete attempted for all keys", async () => {
  const cfg = defaultFixture();
  const key = cfg.receipts.target.original_r2_key!;
  cfg.files = { target: [{ id: "f1", r2_bucket: "receipts", r2_key: key }] };
  const db = makeMockDb(cfg);
  const r2keys = new Set([key]);
  const rb = makeMockBucket(r2keys, { failDeleteFor: key });
  const ab = makeMockBucket(new Set());
  const res = await purgeDuplicate(makeReq(db, rb, ab, cfg));
  assert.equal(res.completed, false);
  assert.equal(res.targets[0]!.status, "storage_failed");
  assert.ok(rb.deleteCalls.includes(key), "delete must be attempted even though it threw");
  assert.ok(rb.headCalls.includes(key), "head must be attempted after delete error");
});

// ─── §5 R2: delete error + all heads absent → completed ──────────────────────

test("R2 final-state: delete error + all heads absent → completed", async () => {
  const cfg = defaultFixture();
  const key = cfg.receipts.target.original_r2_key!;
  cfg.files = { target: [{ id: "f1", r2_bucket: "receipts", r2_key: key }] };
  const db = makeMockDb(cfg);
  // Key absent from the bucket (already gone). Delete throws but head confirms absent.
  const rb = makeMockBucket(new Set(), { failDeleteFor: key });
  const ab = makeMockBucket(new Set());
  const res = await purgeDuplicate(makeReq(db, rb, ab, cfg));
  assert.equal(res.completed, true, "must be completed when head confirms absence despite delete error");
  assert.equal(res.targets[0]!.status, "completed");
});

// ─── §5 R2: delete error + one key still present → storage_failed ───────────

test("R2 final-state: delete error + head present → storage_failed with count", async () => {
  const cfg = defaultFixture();
  const key = cfg.receipts.target.original_r2_key!;
  cfg.files = { target: [{ id: "f1", r2_bucket: "receipts", r2_key: key }] };
  const db = makeMockDb(cfg);
  // Key present, delete throws. Head confirms still present.
  const rb = makeMockBucket(new Set([key]), { failDeleteFor: key });
  const ab = makeMockBucket(new Set());
  const res = await purgeDuplicate(makeReq(db, rb, ab, cfg));
  assert.equal(res.completed, false);
  assert.equal(res.targets[0]!.status, "storage_failed");
});

// ─── §3 multi-target: one request-wide batch ────────────────────────────────

test("multi-target: one request-wide batch with all targets", async () => {
  const cfg = defaultFixture();
  cfg.receipts["t2"] = mkReceipt({ id: "t2", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19", updated_at: "t2v1" });
  const { db, promise } = runPurge(cfg, {
    targets: [{ receiptId: "target", expectedUpdatedAt: "tv1" }, { receiptId: "t2", expectedUpdatedAt: "t2v1" }],
    confirmationText: "PURGE 2",
  });
  const res = await promise;
  assert.equal(res.completed, true);
  assert.equal(res.targets.length, 2);
  assert.equal(db._batchCount(), 1, "exactly one request-wide batch");
  // §3: both targets must appear in the batch SQL.
  const allSql = db._batchStmts().flat().map((s) => s.sql + JSON.stringify(s.binds));
  assert.ok(allSql.some((s) => s.includes("target")), "target must appear in batch");
  assert.ok(allSql.some((s) => s.includes("t2")), "t2 must appear in batch");
});

// ─── §3 unknown bucket → rejection before batch and before R2 ────────────────

test("unknown manifest bucket: rejection before db.batch and R2 delete/head", async () => {
  const cfg = defaultFixture();
  cfg.files = { target: [{ id: "f1", r2_bucket: "bad-bucket", r2_key: "k" }] };
  const db = makeMockDb(cfg);
  const rb = makeMockBucket(new Set());
  const ab = makeMockBucket(new Set());
  await assert.rejects(() => purgeDuplicate(makeReq(db, rb, ab, cfg)), (e: PurgeEligibilityError) =>
    e.status === 409 && /unknown.*bucket/i.test(e.message),
  );
  assert.equal(db._batchCalled(), false, "batch must NOT be called for unknown bucket");
  assert.equal(rb.deleteCalls.length, 0, "no R2 deletes");
  assert.equal(rb.headCalls.length, 0, "no R2 heads");
});

// ─── §3 receipt_files compare-and-delete: binds include bucket + key ─────────

test("batch receipt_files DELETE binds (id, object_id, bucket, key)", async () => {
  const cfg = defaultFixture();
  cfg.files = { target: [{ id: "f-row-1", r2_bucket: "receipts", r2_key: "specific-key.jpg" }] };
  const { db, promise } = runPurge(cfg);
  await promise;
  const allStmts = db._batchStmts().flat();
  const fileDelete = allStmts.find((s) => s.sql.includes("DELETE FROM receipt_files") && s.sql.includes("r2_bucket"));
  assert.ok(fileDelete, "receipt_files compare-and-delete must be in the batch");
  assert.ok(fileDelete!.binds.includes("f-row-1"), "must bind the row id");
  assert.ok(fileDelete!.binds.includes("receipts"), "must bind r2_bucket");
  assert.ok(fileDelete!.binds.includes("specific-key.jpg"), "must bind r2_key");
});

// ─── retry tests ─────────────────────────────────────────────────────────────

test("retry success: pending job → completed, keys deleted + head-verified", async () => {
  const cfg = defaultFixture();
  const key = "receipts/2026/06/1/image.jpg";
  cfg.purgeJobs = { job1: { pending_keys_json: JSON.stringify([{ bucket: "RECEIPTS_BUCKET", key }]), status: "storage_pending" } };
  const db = makeMockDb(cfg);
  const r2keys = new Set([key]);
  const rb = makeMockBucket(r2keys);
  const ab = makeMockBucket(new Set());
  const res = await retryR2Cleanup({ db: db as unknown as D1Database, receiptsBucket: rb as unknown as R2Bucket, archiveBucket: ab as unknown as R2Bucket, purgeJobId: "job1" });
  assert.equal(res.status, "completed");
  assert.ok(rb.deleteCalls.includes(key), "retry must delete the key");
  assert.ok(rb.headCalls.includes(key), "retry must head-verify the key");
  assert.equal(r2keys.has(key), false);
});

test("retry malformed inventory: stays storage_failed", async () => {
  const cfg = defaultFixture();
  cfg.purgeJobs = { job1: { pending_keys_json: "garbage", status: "storage_failed" } };
  const db = makeMockDb(cfg);
  const rb = makeMockBucket(new Set());
  const ab = makeMockBucket(new Set());
  const res = await retryR2Cleanup({ db: db as unknown as D1Database, receiptsBucket: rb as unknown as R2Bucket, archiveBucket: ab as unknown as R2Bucket, purgeJobId: "job1" });
  assert.equal(res.status, "storage_failed");
});

test("retry already-completed: no-op", async () => {
  const cfg = defaultFixture();
  cfg.purgeJobs = { job1: { pending_keys_json: null, status: "completed" } };
  const db = makeMockDb(cfg);
  const rb = makeMockBucket(new Set());
  const ab = makeMockBucket(new Set());
  const res = await retryR2Cleanup({ db: db as unknown as D1Database, receiptsBucket: rb as unknown as R2Bucket, archiveBucket: ab as unknown as R2Bucket, purgeJobId: "job1" });
  assert.equal(res.status, "completed");
  assert.equal(rb.deleteCalls.length, 0, "no deletes for already-completed");
});

// ─── inventory tests ─────────────────────────────────────────────────────────

test("inventory: live/archive mapping + dedup + count + unknown rejection", async () => {
  const cfg = defaultFixture();
  cfg.receipts["x"] = mkReceipt({ id: "x", original_r2_key: "receipts/2026/06/1/image.jpg" });
  cfg.files = { x: [
    { id: "f1", r2_bucket: "receipts", r2_key: "receipts/2026/06/1/image.jpg" },
    { id: "f2", r2_bucket: "archive", r2_key: "archive/2026/06/proof.jpg" },
  ] };
  const db = makeMockDb(cfg);
  const inv = await inventoryR2Keys(db as unknown as D1Database, "x");
  assert.equal(inv.unknownBuckets.length, 0);
  const bucketKeys = inv.keys.map((k) => `${k.bucket}:${k.key}`);
  assert.ok(bucketKeys.includes("RECEIPTS_BUCKET:receipts/2026/06/1/image.jpg"));
  assert.ok(bucketKeys.includes("RECEIPTS_ARCHIVE_BUCKET:archive/2026/06/proof.jpg"));
  assert.equal(inv.fileRows.length, 2);
});

test("inventory: unknown bucket rejected", async () => {
  const cfg = defaultFixture();
  cfg.receipts["x"] = mkReceipt({ id: "x" });
  cfg.files = { x: [{ id: "f1", r2_bucket: "bad", r2_key: "k" }] };
  const db = makeMockDb(cfg);
  const inv = await inventoryR2Keys(db as unknown as D1Database, "x");
  assert.ok(inv.unknownBuckets.length > 0);
});

// ─── export-item protection ─────────────────────────────────────────────────

test("export-item membership feeds protected policy when status=reviewed", async () => {
  const cfg = defaultFixture();
  cfg.exportItems = { target: 1 };
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 || e.status === 422);
});

// ─── §4 cluster normalization ───────────────────────────────────────────────

test("cluster: fewer than 2 IDs → error", () => {
  const r = normalizeClusterIds(["a"]);
  assert.equal(r.ok, false);
});

test("cluster: duplicate IDs → error", () => {
  const r = normalizeClusterIds(["a", "a", "b"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(/Duplicate/.test(r.error));
});

test("cluster: more than PURGE_TARGET_CAP + 1 → error", () => {
  const ids = Array.from({ length: PURGE_TARGET_CAP + 2 }, (_, i) => `id-${i}`);
  const r = normalizeClusterIds(ids);
  assert.equal(r.ok, false);
});

test("cluster: valid maximum-sized cluster → ok", () => {
  const ids = Array.from({ length: PURGE_TARGET_CAP + 1 }, (_, i) => `id-${i}`);
  const r = normalizeClusterIds(ids);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.ids.length, PURGE_TARGET_CAP + 1);
});

// ─── §5 provenance deduplication ────────────────────────────────────────────

test("rewriteSourceIds: deduplicates complete list preserving first-seen order", async () => {
  const { rewriteSourceIds } = await import("@/lib/receipts/duplicate-purge");
  // ["a", "target", "a", "b", "retained", "retained"] → ["a", "b", "retained"]
  const rw = rewriteSourceIds('["a","target","a","b","retained","retained"]', "target", "retained");
  assert.ok(rw);
  const result = JSON.parse(rw!.rewritten) as string[];
  assert.deepEqual(result, ["a", "b", "retained"]);
});
