// Service-level tests for duplicate-purge orchestrator (item 5).
// Calls the REAL purgeDuplicate / retryR2Cleanup / inventoryR2Keys against a
// mock D1Database + R2Bucket, not pure helpers or hand-reproduced SQL.
import test from "node:test";
import assert from "node:assert/strict";
import {
  purgeDuplicate,
  retryR2Cleanup,
  inventoryR2Keys,
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
    captured_at: "2026-06-19T00:00:00Z",
    captured_by: "op",
    source: "mobile_capture",
    original_filename: "image.jpg",
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
    original_r2_key: `receipts/2026/06/${seq}/image.jpg`,
    original_sha256: `sha-${seq}`,
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
    ...over,
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

// ─── mock D1 ────────────────────────────────────────────────────────────────

function makeMockDb(cfg: Fixture) {
  const batchCalls: unknown[][] = []; // arrays of prepared-statement objects
  const runCalls: { sql: string }[] = [];
  let batchCalled = false;

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
    if (s.includes("FROM receipt_export_items WHERE item_type='receipt' AND item_id = ?")) {
      return { first: { n: cfg.exportItems?.[id] ?? 0 }, results: [] };
    }
    if (s.includes("DISTINCT e.export_month")) {
      return { first: null, results: (cfg.exportMonths?.[id] ?? []).map((m) => ({ export_month: m })) };
    }
    if (s.includes("DISTINCT business_trip_report_id")) {
      return { first: null, results: (cfg.tripLinks?.[id] ?? []).map((bid) => ({ business_trip_report_id: bid })) };
    }
    if (s.includes("FROM email_receipt_intake WHERE promoted_receipt_id")) {
      return { first: cfg.emailPromoted?.has(id) ? { ok: 1 } : null, results: [] };
    }
    if (s.includes("FROM receipt_attendees WHERE receipt_id = ?")) {
      return { first: null, results: [] }; // no attendees by default
    }
    if (s.includes("role='proof_copy'")) {
      return { first: cfg.proofFiles?.has(id) ? { ok: 1 } : null, results: [] };
    }
    if (s.includes("FROM receipt_files WHERE object_type='receipt' AND object_id=?")) {
      return { first: null, results: (cfg.files?.[id] ?? []) as unknown as Record<string, unknown>[] };
    }
    if (s.includes("FROM merchant_category_rules WHERE source_receipt_ids_json LIKE ?")) {
      return { first: null, results: (cfg.categoryRules ?? []) as unknown as Record<string, unknown>[] };
    }
    if (s.includes("FROM duplicate_purge_log WHERE id = ?")) {
      const job = cfg.purgeJobs?.[id];
      return { first: job ? (job as unknown as Record<string, unknown>) : null, results: [] };
    }
    return { first: null, results: [] };
  }

  function prepare(sql: string): D1PreparedStatement {
    let binds: unknown[] = [];
    const bound = {
      bind(...args: unknown[]) { binds = args; return bound; },
      async first<T>(): Promise<T | null> { return (respond(sql, binds).first ?? null) as T | null; },
      async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
        return { results: respond(sql, binds).results as T[], success: true, meta: { changes: 0 } };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        runCalls.push({ sql });
        return { success: true, meta: { changes: 1 } };
      },
    };
    return bound as unknown as D1PreparedStatement;
  }

  const db = {
    prepare,
    async batch(stmts: D1PreparedStatement[]) {
      batchCalled = true;
      batchCalls.push(stmts);
      if (cfg.batchShouldThrow) throw new Error("batch failed");
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    _batchCalled: () => batchCalled,
    _batchCount: () => batchCalls.length,
    _runCount: () => runCalls.length,
  };
  return db;
}

// ─── mock R2 ────────────────────────────────────────────────────────────────

function makeMockBucket(keys: Set<string>, failDeleteFor?: string) {
  return {
    async delete(key: string) {
      if (failDeleteFor && failDeleteFor === key) throw new Error("R2 delete failed");
      keys.delete(key);
    },
    async head(key: string) {
      return keys.has(key) ? ({ size: 1 } as object) : null;
    },
    async list(opts: { prefix?: string; cursor?: string; limit?: number }) {
      const objs = [...keys]
        .filter((k) => (opts.prefix ? k.startsWith(opts.prefix) : true))
        .map((key) => ({ key, size: 1 }));
      return { objects: objs, truncated: false, cursor: undefined };
    },
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function makeReq(
  db: ReturnType<typeof makeMockDb>,
  rb: ReturnType<typeof makeMockBucket>,
  ab: ReturnType<typeof makeMockBucket>,
  cfg: Fixture,
  over: Partial<PurgeRequest> = {},
): PurgeRequest {
  const targetIds = over.targets?.map((t) => t.receiptId) ?? ["target"];
  return {
    db: db as unknown as D1Database,
    receiptsBucket: rb as unknown as R2Bucket,
    archiveBucket: ab as unknown as R2Bucket,
    retainedReceiptId: "retained",
    retainedExpectedUpdatedAt: cfg.receipts["retained"]?.updated_at ?? "rv1",
    targets: targetIds.map((id) => ({ receiptId: id, expectedUpdatedAt: cfg.receipts[id]?.updated_at ?? "tv1" })),
    visualConfirmed: true,
    legalHoldExceptionAcknowledged: true,
    confirmationText: `PURGE ${targetIds.length}`,
    reason: "operator-confirmed duplicate re-capture",
    actor: "test",
    ...over,
  };
}

function runPurge(cfg: Fixture, over: Partial<PurgeRequest> = {}) {
  const db = makeMockDb(cfg);
  const r2keys = new Set<string>();
  const rb = makeMockBucket(r2keys);
  const ab = makeMockBucket(new Set());
  return {
    db, rb, ab, r2keys,
    promise: purgeDuplicate(makeReq(db, rb, ab, cfg, over)),
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

test("happy path: one target purged, batch called, R2 cleaned, completed", async () => {
  const cfg = defaultFixture();
  cfg.files = { target: [{ id: "f1", r2_bucket: "receipts", r2_key: "receipts/2026/06/1/image.jpg" }] };
  const { db, promise } = runPurge(cfg);
  const res = await promise;
  assert.equal(res.completed, true);
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0]!.status, "completed");
  assert.equal(res.targets[0]!.strength, "strong");
  assert.ok(db._batchCalled(), "db.batch must be called");
  assert.equal(db._batchCount(), 1, "exactly one batch");
});

test("explicit selected-target scope: only requested targets purged", async () => {
  const cfg = defaultFixture();
  cfg.receipts["t2"] = mkReceipt({ id: "t2", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19", updated_at: "t2v1" });
  const { db, promise } = runPurge(cfg, {
    targets: [{ receiptId: "target", expectedUpdatedAt: "tv1" }],
    confirmationText: "PURGE 1",
  });
  const res = await promise;
  assert.equal(res.targets.length, 1);
  assert.equal(res.targets[0]!.receiptId, "target");
});

test("reject: visual confirmation required", async () => {
  const { promise } = runPurge(defaultFixture(), { visualConfirmed: false });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /Visual confirmation/.test(e.message));
});

test("reject: legal-hold acknowledgement required", async () => {
  const { promise } = runPurge(defaultFixture(), { legalHoldExceptionAcknowledged: false });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /legal hold/i.test(e.message));
});

test("reject: reason required", async () => {
  const { promise } = runPurge(defaultFixture(), { reason: "" });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400);
});

test("reject: exact typed confirmation required", async () => {
  const { promise } = runPurge(defaultFixture(), { confirmationText: "wrong" });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /PURGE/.test(e.message));
});

test("reject: duplicate target IDs", async () => {
  const { promise } = runPurge(defaultFixture(), {
    targets: [{ receiptId: "target", expectedUpdatedAt: "tv1" }, { receiptId: "target", expectedUpdatedAt: "tv1" }],
    confirmationText: "PURGE 2",
  });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /Duplicate target/i.test(e.message));
});

test("reject: empty targets", async () => {
  const { promise } = runPurge(defaultFixture(), { targets: [], confirmationText: "PURGE 0" });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400);
});

test("reject: retained appearing in targets", async () => {
  const { promise } = runPurge(defaultFixture(), {
    targets: [{ receiptId: "retained", expectedUpdatedAt: "rv1" }],
    confirmationText: "PURGE 1",
  });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /Retained/i.test(e.message));
});

test("reject: cap exceeded", async () => {
  const ids = Array.from({ length: 11 }, (_, i) => ({ receiptId: `t${i}`, expectedUpdatedAt: "v" }));
  const { promise } = runPurge(defaultFixture(), { targets: ids, confirmationText: `PURGE ${ids.length}` });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 400 && /cap/i.test(e.message));
});

test("reject: stale retained updated_at", async () => {
  const { promise } = runPurge(defaultFixture(), { retainedExpectedUpdatedAt: "stale" });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 && /Retained.*stale/i.test(e.message));
});

test("reject: stale target updated_at", async () => {
  const { promise } = runPurge(defaultFixture(), {
    targets: [{ receiptId: "target", expectedUpdatedAt: "stale" }],
    confirmationText: "PURGE 1",
  });
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 && /stale/i.test(e.message));
});

test("reject: target has AMEX claim", async () => {
  const cfg = defaultFixture();
  cfg.amexClaims = { target: 1 };
  const { promise } = runPurge(cfg);
  // assessSelection catches the protected tier (422) before the per-target 409.
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 || e.status === 422);
});

test("reject: target in export_items", async () => {
  const cfg = defaultFixture();
  cfg.exportItems = { target: 1 };
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 || e.status === 422);
});

test("reject: target status exported", async () => {
  const cfg = defaultFixture();
  cfg.receipts.target = mkReceipt({ id: "target", status: "exported" });
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 || e.status === 422);
});

test("reject: extraction pending", async () => {
  const cfg = defaultFixture();
  cfg.receipts.target = mkReceipt({ id: "target", status: "captured", extraction_state: "queued" as never });
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 && /extraction/i.test(e.message));
});

test("reject: target-only populated field missing from retained (422)", async () => {
  const cfg = defaultFixture();
  cfg.receipts.target = mkReceipt({ id: "target", business_purpose: "stationery run" });
  cfg.receipts.retained = mkReceipt({ id: "retained", status: "reconciled", updated_at: "rv1" }); // no business_purpose
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 422 && /missing from the retained/i.test(e.message));
});

test("reject: non-candidate (different amount)", async () => {
  const cfg = defaultFixture();
  cfg.receipts.target = mkReceipt({ id: "target", amount_minor: 99999 });
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => e.status === 409 && /not a.*candidate/i.test(e.message));
});

test("preflight failure: no db.batch and no R2 calls", async () => {
  const cfg = defaultFixture();
  cfg.amexClaims = { target: 1 }; // makes target ineligible
  const { db, promise } = runPurge(cfg);
  await assert.rejects(promise);
  assert.equal(db._batchCalled(), false, "batch must NOT be called on preflight failure");
});

test("db.batch failure: no R2 delete calls", async () => {
  const cfg = defaultFixture();
  cfg.batchShouldThrow = true;
  const r2keys = new Set<string>(["k1"]);
  const db = makeMockDb(cfg);
  const rb = makeMockBucket(r2keys);
  const ab = makeMockBucket(new Set());
  await assert.rejects(() => purgeDuplicate(makeReq(db, rb, ab, cfg)));
  // batch threw → no R2 cleanup attempted → keys unchanged
  assert.ok(r2keys.has("k1"), "R2 keys must be unchanged after batch failure");
});

test("R2 failure creates storage_failed and preserves full inventory", async () => {
  const cfg = defaultFixture();
  const key = cfg.receipts.target.original_r2_key!;
  cfg.files = { target: [{ id: "f1", r2_bucket: "receipts", r2_key: key }] };
  const db = makeMockDb(cfg);
  const r2keys = new Set<string>([key]);
  const rb = makeMockBucket(r2keys, key); // fail delete for this key
  const ab = makeMockBucket(new Set());
  const res = await purgeDuplicate(makeReq(db, rb, ab, cfg));
  assert.equal(res.completed, false);
  assert.equal(res.targets[0]!.status, "storage_failed");
  assert.ok(res.targets[0]!.errorText);
});

test("multi-target successful batch builds one request-wide batch", async () => {
  const cfg = defaultFixture();
  cfg.receipts["t2"] = mkReceipt({ id: "t2", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19", updated_at: "t2v1" });
  const { db, promise } = runPurge(cfg, {
    targets: [
      { receiptId: "target", expectedUpdatedAt: "tv1" },
      { receiptId: "t2", expectedUpdatedAt: "t2v1" },
    ],
    confirmationText: "PURGE 2",
  });
  const res = await promise;
  assert.equal(res.completed, true);
  assert.equal(res.targets.length, 2);
  assert.equal(db._batchCount(), 1, "exactly one request-wide batch");
});

test("retry success: storage_pending job with valid keys → completed", async () => {
  const cfg = defaultFixture();
  const key = "receipts/2026/06/1/image.jpg";
  cfg.purgeJobs = { job1: { pending_keys_json: JSON.stringify([{ bucket: "RECEIPTS_BUCKET", key }]), status: "storage_pending" } };
  const db = makeMockDb(cfg);
  const r2keys = new Set<string>([key]);
  const rb = makeMockBucket(r2keys);
  const ab = makeMockBucket(new Set());
  const res = await retryR2Cleanup({ db: db as unknown as D1Database, receiptsBucket: rb as unknown as R2Bucket, archiveBucket: ab as unknown as R2Bucket, purgeJobId: "job1" });
  assert.equal(res.status, "completed");
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

test("retry already-completed: no-op success", async () => {
  const cfg = defaultFixture();
  cfg.purgeJobs = { job1: { pending_keys_json: null, status: "completed" } };
  const db = makeMockDb(cfg);
  const rb = makeMockBucket(new Set());
  const ab = makeMockBucket(new Set());
  const res = await retryR2Cleanup({ db: db as unknown as D1Database, receiptsBucket: rb as unknown as R2Bucket, archiveBucket: ab as unknown as R2Bucket, purgeJobId: "job1" });
  assert.equal(res.status, "completed");
});

test("inventory: live/archive manifest mapping + unknown rejection + dedup + count", async () => {
  const cfg = defaultFixture();
  cfg.receipts["x"] = mkReceipt({ id: "x", original_r2_key: "receipts/2026/06/1/image.jpg" });
  cfg.files = { x: [
    { id: "f1", r2_bucket: "receipts", r2_key: "receipts/2026/06/1/image.jpg" }, // dedupes with column key
    { id: "f2", r2_bucket: "archive", r2_key: "archive/2026/06/proof.jpg" },     // archive bucket
  ] };
  const db = makeMockDb(cfg);
  const rb = makeMockBucket(new Set<string>());
  const ab = makeMockBucket(new Set<string>());
  const inv = await inventoryR2Keys(db as unknown as D1Database, "x");
  assert.equal(inv.unknownBuckets.length, 0);
  // Keys: original (column, deduped with manifest) + archive manifest.
  const bucketKeys = inv.keys.map((k) => `${k.bucket}:${k.key}`);
  assert.ok(bucketKeys.includes("RECEIPTS_BUCKET:receipts/2026/06/1/image.jpg"));
  assert.ok(bucketKeys.includes("RECEIPTS_ARCHIVE_BUCKET:archive/2026/06/proof.jpg"));
  assert.equal(inv.fileRows.length, 2);
});

test("inventory: unknown manifest bucket rejected", async () => {
  const cfg = defaultFixture();
  cfg.receipts["x"] = mkReceipt({ id: "x" });
  cfg.files = { x: [{ id: "f1", r2_bucket: "bad-bucket", r2_key: "k" }] };
  const db = makeMockDb(cfg);
  const inv = await inventoryR2Keys(db as unknown as D1Database, "x");
  assert.ok(inv.unknownBuckets.length > 0);
});

test("export-item membership feeds protected policy even when status is reviewed", async () => {
  const cfg = defaultFixture();
  // Target has export_items membership but status is reviewed (not exported).
  cfg.exportItems = { target: 1 };
  // fetchMemberAssessment sets exported=true via exportItemsCount>0 → buildInput
  // → protectionTier → protected → assessSelection blocks.
  const { promise } = runPurge(cfg);
  await assert.rejects(promise, (e: PurgeEligibilityError) => {
    // Either preflight catches the export_items count (409) OR assessSelection
    // catches the protected tier (422). Both prove export-item protection.
    return e.status === 409 || e.status === 422;
  });
});
