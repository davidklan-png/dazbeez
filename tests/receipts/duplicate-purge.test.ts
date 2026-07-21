import test from "node:test";
import assert from "node:assert/strict";
import {
  purgeDuplicate,
  retryR2Cleanup,
  inventoryR2Keys,
  PurgeEligibilityError,
  type PurgeRequest,
} from "@/lib/receipts/duplicate-purge";
import type { ReceiptRecord } from "@/lib/receipts/types";

// ─── fakes ──────────────────────────────────────────────────────────────────

/** A minimal D1 fake: route by first-matching SQL substring to a responder. */
interface FakeD1Config {
  /** id -> receipt row (partial). */
  receipts: Record<string, Partial<ReceiptRecord>>;
  /** id -> amex claim count (matched/confirmed). */
  amexClaims?: Record<string, number>;
  /** id -> claim row for cluster GET-style lookups (not used by purge). */
  exportItems?: Record<string, number>;
  attendees?: Record<string, number>;
  files?: Record<string, Array<{ r2_bucket: string; r2_key: string }>>;
  tripLinks?: Record<string, Array<{ id: string; business_trip_report_id: string }>>;
  categoryRules?: Array<{ id: string; source_receipt_ids_json: string | null }>;
  batchShouldThrow?: boolean;
  /** Served by SELECT … FROM duplicate_purge_log WHERE id = ? (mutable: set before retry). */
  purgeJob?: { pending_keys_json: string | null; status: string } | null;
}

function makeFakeDb(cfg: FakeD1Config) {
  const batchStmts: { sql: string; binds: unknown[] }[] = [];
  const runStmts: { sql: string; binds: unknown[] }[] = [];
  const sql = (s: string) => s.replace(/\s+/g, " ").trim();

  function responder(rawStmt: string, binds: unknown[]):
    | { first: Record<string, unknown> | null; results: Record<string, unknown>[] }
    | null {
    const s = sql(rawStmt);
    const bind0 = binds[0] as string | undefined;
    // SELECT receipt_records by id
    if (s.includes("FROM receipt_records WHERE id = ?")) {
      if (s.includes("original_r2_key, processed_r2_key")) {
        const r = cfg.receipts[bind0 ?? ""];
        return {
          first: r
            ? {
                original_r2_key: r.original_r2_key ?? null,
                processed_r2_key: r.processed_r2_key ?? null,
                extraction_r2_key: null,
                original_sha256: r.original_sha256 ?? "sha-" + (bind0 ?? ""),
              }
            : null,
          results: [],
        };
      }
      const r = cfg.receipts[bind0 ?? ""];
      return {
        first: r ? (r as unknown as Record<string, unknown>) : null,
        results: r ? [r as unknown as Record<string, unknown>] : [],
      };
    }
    if (s.includes("FROM amex_statement_lines WHERE matched_receipt_id = ?")) {
      if (s.includes("COUNT(*)")) {
        return { first: { n: cfg.amexClaims?.[bind0 ?? ""] ?? 0 }, results: [] };
      }
      // LIMIT 1 claim lookup
      const n = cfg.amexClaims?.[bind0 ?? ""] ?? 0;
      return { first: n > 0 ? { statement_month: "2026-08", id: "line-" + bind0 } : null, results: [] };
    }
    if (s.includes("FROM receipt_export_items WHERE item_type='receipt' AND item_id = ?")) {
      return { first: { n: cfg.exportItems?.[bind0 ?? ""] ?? 0 }, results: [] };
    }
    if (s.includes("FROM receipt_attendees WHERE receipt_id = ?")) {
      return { first: { n: cfg.attendees?.[bind0 ?? ""] ?? 0 }, results: [] };
    }
    if (s.includes("FROM receipt_files WHERE object_type='receipt' AND object_id=?")) {
      return { first: null, results: (cfg.files?.[bind0 ?? ""] ?? []) as Record<string, unknown>[] };
    }
    if (s.includes("FROM business_trip_report_receipts WHERE receipt_id = ?")) {
      return { first: null, results: (cfg.tripLinks?.[bind0 ?? ""] ?? []) as Record<string, unknown>[] };
    }
    if (s.includes("FROM merchant_category_rules WHERE source_receipt_ids_json LIKE ?")) {
      return { first: null, results: (cfg.categoryRules ?? []) as unknown as Record<string, unknown>[] };
    }
    if (s.includes("FROM duplicate_purge_log WHERE id = ?")) {
      return { first: (cfg.purgeJob ?? null) as Record<string, unknown> | null, results: [] };
    }
    return null;
  }

  function stmt(rawSql: string) {
    let binds: unknown[] = [];
    const bound = {
      bind(...args: unknown[]) {
        binds = args;
        return bound;
      },
      async first<T>() {
        const r = responder(rawSql, binds);
        return (r?.first ?? null) as T | null;
      },
      async all<T>() {
        const r = responder(rawSql, binds);
        return { results: (r?.results ?? []) as T[], success: true, meta: { changes: 0 } };
      },
      async run() {
        runStmts.push({ sql: rawSql, binds });
        return { success: true, meta: { changes: 1 } };
      },
    };
    return bound;
  }

  const db = {
    prepare: (s: string) => stmt(s),
    async batch(items: ReturnType<typeof stmt>[]) {
      if (cfg.batchShouldThrow) throw new Error("batch failed");
      // D1 batch runs prepared statements; record their sql by inspecting the
      // closure is not possible, so we mark that a batch of N ran.
      batchStmts.push({ sql: `BATCH(${items.length})`, binds: [] });
      return items.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    _batchStmts: batchStmts,
    _runStmts: runStmts,
  };
  return db;
}

interface FakeBucketCfg {
  keys: Set<string>;
  deleteShouldThrowFor?: string;
  // head returns a truthy object if the key still exists.
}
function makeFakeBucket(cfg: { keys: Set<string>; failDelete?: string }) {
  return {
    async delete(key: string) {
      if (cfg.failDelete === key) throw new Error("R2 delete failed (simulated)");
      cfg.keys.delete(key);
    },
    async head(key: string) {
      return cfg.keys.has(key) ? ({ size: 1 } as R2ObjectBody) : null;
    },
    async list(opts: { prefix?: string }) {
      const objs = [...cfg.keys]
        .filter((k) => (opts.prefix ? k.startsWith(opts.prefix) : true))
        .map((key) => ({ key, size: 1 }));
      return { objects: objs, truncated: false } as unknown as R2ListResult;
    },
  };
}

type R2ObjectBody = { size: number };
type R2ListResult = { objects: Array<{ key: string; size: number }>; truncated: boolean };

// Build a base request with two-cluster fixtures.
function baseReceipts(): Record<string, Partial<ReceiptRecord>> {
  return {
    // retained: claimed (protected), richer.
    retained: {
      id: "retained",
      captured_at: "2026-06-09T00:00:00Z",
      updated_at: "v1",
      status: "reconciled",
      deleted_at: null,
      merchant: "岡芳商店",
      amount_minor: 3862,
      currency: "JPY",
      transaction_date: "2026-06-19",
      expense_category_code: "supplies",
      extraction_state: "processed",
      original_r2_key: "receipts/2026/06/orig-retained.jpg",
      original_content_type: "image/jpeg",
      original_sha256: "sha-retained",
    } as Partial<ReceiptRecord>,
    // target: unregistered, strong duplicate of retained (same merchant/amount/date).
    target: {
      id: "target",
      captured_at: "2026-06-20T00:00:00Z",
      updated_at: "v1",
      status: "reviewed",
      deleted_at: null,
      merchant: "岡芳商店",
      amount_minor: 3862,
      currency: "JPY",
      transaction_date: "2026-06-19",
      extraction_state: "processed",
      original_r2_key: "receipts/2026/06/orig-target.jpg",
      original_content_type: "image/jpeg",
      original_sha256: "sha-target",
    } as Partial<ReceiptRecord>,
  };
}

function makeReq(
  db: ReturnType<typeof makeFakeDb>,
  receiptsBucket: ReturnType<typeof makeFakeBucket>,
  archiveBucket: ReturnType<typeof makeFakeBucket>,
  over: Partial<PurgeRequest> = {},
): PurgeRequest {
  return {
    db: db as unknown as D1Database,
    receiptsBucket: receiptsBucket as unknown as R2Bucket,
    archiveBucket: archiveBucket as unknown as R2Bucket,
    retainedReceiptId: "retained",
    purgeReceiptIds: ["target"],
    expectedUpdatedAt: { target: "v1" },
    visualConfirmed: true,
    confirmationText: "1",
    reason: "operator-confirmed duplicate re-capture",
    strength: "strong",
    actor: "test-operator",
    ...over,
  };
}

// ─── happy path ──────────────────────────────────────────────────────────────

test("happy path: target purged, D1 batch ran, R2 deleted+verified, tombstone completed", async () => {
  const keys = new Set<string>(["receipts/2026/06/orig-target.jpg"]);
  const db = makeFakeDb({
    receipts: baseReceipts(),
    files: { target: [{ r2_bucket: "RECEIPTS_BUCKET", r2_key: "receipts/2026/06/orig-target.jpg" }] },
  });
  const rb = makeFakeBucket({ keys });
  const ab = makeFakeBucket({ keys: new Set() });
  const res = await purgeDuplicate(makeReq(db, rb, ab));
  assert.equal(res.completed, true);
  assert.equal(res.targets[0]!.status, "completed");
  assert.equal(res.targets[0]!.objectCount, 1); // original key (column) = manifest row, deduped
  assert.equal(db._batchStmts.length, 1, "one atomic D1 batch should have run");
  assert.equal(keys.has("receipts/2026/06/orig-target.jpg"), false, "R2 object deleted");
});

// ─── eligibility rejections (server authority) ───────────────────────────────

test("reject: visual confirmation required", async () => {
  const db = makeFakeDb({ receipts: baseReceipts() });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }), { visualConfirmed: false })),
    (e: PurgeEligibilityError) => e.status === 400 && /Visual confirmation/.test(e.message),
  );
});

test("reject: reason required", async () => {
  const db = makeFakeDb({ receipts: baseReceipts() });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }), { reason: "" })),
    (e: PurgeEligibilityError) => e.status === 400,
  );
});

test("reject: typed confirmation (count or id prefix) required", async () => {
  const db = makeFakeDb({ receipts: baseReceipts() });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }), { confirmationText: "wrong" })),
    (e: PurgeEligibilityError) => e.status === 400 && /confirmation/i.test(e.message),
  );
});

test("reject: target status exported (409)", async () => {
  const rcpts = baseReceipts();
  (rcpts.target as ReceiptRecord).status = "exported";
  const db = makeFakeDb({ receipts: rcpts });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }))),
    (e: PurgeEligibilityError) => e.status === 409 && /status/i.test(e.message),
  );
});

test("reject: target claimed by confirmed AMEX line (409)", async () => {
  const db = makeFakeDb({ receipts: baseReceipts(), amexClaims: { target: 1 } });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }))),
    (e: PurgeEligibilityError) => e.status === 409 && /AMEX line/i.test(e.message),
  );
});

test("reject: target in receipt_export_items (409)", async () => {
  const db = makeFakeDb({ receipts: baseReceipts(), exportItems: { target: 1 } });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }))),
    (e: PurgeEligibilityError) => e.status === 409 && /export_items/i.test(e.message),
  );
});

test("reject: target extraction still pending (409)", async () => {
  const rcpts = baseReceipts();
  (rcpts.target as ReceiptRecord).extraction_state = "queued";
  (rcpts.target as ReceiptRecord).status = "captured";
  const db = makeFakeDb({ receipts: rcpts });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }))),
    (e: PurgeEligibilityError) => e.status === 409 && /extraction/i.test(e.message),
  );
});

test("reject: stale updated_at (409)", async () => {
  const db = makeFakeDb({ receipts: baseReceipts() });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }), { expectedUpdatedAt: { target: "stale" } })),
    (e: PurgeEligibilityError) => e.status === 409 && /stale|updated_at/i.test(e.message),
  );
});

test("reject: target has populated field missing from retained (422)", async () => {
  const rcpts = baseReceipts();
  // retained has NO business_purpose; target HAS one → missing-from-retained.
  (rcpts.target as ReceiptRecord).business_purpose = "stationery run";
  const db = makeFakeDb({ receipts: rcpts });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }))),
    (e: PurgeEligibilityError) => e.status === 422 && /missing from the retained/i.test(e.message),
  );
});

test("reject: target no longer a strong duplicate candidate of retained (409)", async () => {
  const rcpts = baseReceipts();
  // Different amount → not a strong/near candidate.
  (rcpts.target as ReceiptRecord).amount_minor = 99999;
  const db = makeFakeDb({ receipts: rcpts });
  await assert.rejects(
    () => purgeDuplicate(makeReq(db, makeFakeBucket({ keys: new Set() }), makeFakeBucket({ keys: new Set() }))),
    (e: PurgeEligibilityError) => e.status === 409 && /not a strong duplicate candidate/i.test(e.message),
  );
});

// ─── R2 loud + retryable ─────────────────────────────────────────────────────

test("R2 delete failure → storage_failed (never false success); D1 already purged", async () => {
  const key = "receipts/2026/06/orig-target.jpg";
  const keys = new Set<string>([key]);
  const db = makeFakeDb({
    receipts: baseReceipts(),
    files: { target: [{ r2_bucket: "RECEIPTS_BUCKET", r2_key: key }] },
  });
  const rb = makeFakeBucket({ keys, failDelete: key });
  const ab = makeFakeBucket({ keys: new Set() });
  const res = await purgeDuplicate(makeReq(db, rb, ab));
  assert.equal(res.completed, false);
  assert.equal(res.targets[0]!.status, "storage_failed");
  assert.ok(res.targets[0]!.errorText && /R2 delete failed/.test(res.targets[0]!.errorText!));
  assert.equal(db._batchStmts.length, 1, "D1 purge committed before R2 cleanup attempted");
});

test("retry completes an interrupted cleanup idempotently; already-absent = success", async () => {
  const key = "receipts/2026/06/orig-target.jpg";
  const keys = new Set<string>([key]);
  const cfg: FakeD1Config = {
    receipts: baseReceipts(),
    files: { target: [{ r2_bucket: "RECEIPTS_BUCKET", r2_key: key }] },
    purgeJob: {
      pending_keys_json: JSON.stringify([{ bucket: "RECEIPTS_BUCKET", key }]),
      status: "storage_failed",
    },
  };
  const db = makeFakeDb(cfg);
  const rb = makeFakeBucket({ keys });
  const ab = makeFakeBucket({ keys: new Set() });
  const res = await retryR2Cleanup({
    db: db as unknown as D1Database,
    receiptsBucket: rb as unknown as R2Bucket,
    archiveBucket: ab as unknown as R2Bucket,
    purgeJobId: "job-1",
  });
  assert.equal(res.status, "completed");
  assert.equal(keys.has(key), false);

  // Idempotent re-retry (already absent) is a success no-op.
  const res2 = await retryR2Cleanup({
    db: db as unknown as D1Database,
    receiptsBucket: rb as unknown as R2Bucket,
    archiveBucket: ab as unknown as R2Bucket,
    purgeJobId: "job-1",
  });
  assert.equal(res2.status, "completed");
});

// ─── R2 inventory dedupe + sources ───────────────────────────────────────────

test("inventory dedupes the original column key against the manifest row", async () => {
  const key = "receipts/2026/06/orig.jpg";
  const db = makeFakeDb({
    receipts: { x: { original_r2_key: key } as Partial<ReceiptRecord> },
    files: { x: [{ r2_bucket: "RECEIPTS_BUCKET", r2_key: key }] },
  });
  const rb = makeFakeBucket({ keys: new Set([`receipts/x/rendered.pdf`]) }); // unmanifested derivative
  const ab = makeFakeBucket({ keys: new Set() });
  const inv = await inventoryR2Keys(
    db as unknown as D1Database,
    rb as unknown as R2Bucket,
    ab as unknown as R2Bucket,
    "x",
  );
  const k = inv.keys.map((r) => r.key).sort();
  // original (deduped with manifest) + the derivative under receipts/x/.
  assert.deepEqual(k, ["receipts/2026/06/orig.jpg", "receipts/x/rendered.pdf"]);
  assert.equal(inv.originalSha256, "sha-x");
});
