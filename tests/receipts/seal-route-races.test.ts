// Seal boundary — ACTUAL route orchestration under real SQLite + fake R2.
// The export month route, the proof route, and the render route execute their
// real code (module-mocked bindings only): admission → claim acquisition →
// build under the 0042 triggers → immutable per-build R2 namespace → one-batch
// publication. Contract coverage: acceptance 1 (edits fenced during a live
// build, loser 409), 7 (claim-expiry healing at admission), 9 (interruption
// before/after puts, committed-but-interrupted response), 10 (failed one-shot
// keeps the explicit decision), 11 (proof/render versioned + fenced), 12
// (downloads resolve the published build namespace).
//
// Mocks follow the render-recovery-routes pattern (node:test mock.module).

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

// NB: month-lock MUST be imported lazily — a static import would resolve the
// REAL @/lib/cloudflare-runtime binding into its module scope before the
// mocks below install, and its getReceiptsDb() (used by
// assertTransactionMonthEditable inside updateReceiptRecord) would miss them.
const loadLock = async () => import("@/lib/receipts/month-lock");

const canMockModules = typeof mock.module === "function";

// ─── Real SQLite over the full migration chain, D1-shaped ───────────────────

interface RawStmt {
  get(...p: unknown[]): Record<string, unknown> | undefined;
  all(...p: unknown[]): Record<string, unknown>[];
  run(...p: unknown[]): { changes: number | bigint };
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStmt;
}

function mkRawDb(): RawDb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- no typings in this @types/node
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => RawDb };
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`db/receipts/${f}`, "utf8"));
  }
  return db;
}

class SqliteD1 {
  readonly db: RawDb = mkRawDb();
  /** Async hook before EVERY statement (reads included) — the pause point. */
  onBeforeStatement: ((sql: string) => Promise<void>) | null = null;
  /** Async hook AFTER a statement executed (its result already captured) —
   *  used to suspend a caller between its unlocked read and its next step. */
  onAfterStatement: ((sql: string) => Promise<void>) | null = null;
  /** When set, a statement matching this predicate throws BEFORE running. */
  injectFailure: ((sql: string) => Error | null) | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  prepare(sql: string) {
    // The bound form carries the args; the bare form (no .bind) runs with none
    // — some helpers call prepare(sql).all() directly.
    const make = (args: unknown[]) => {
      const spec = { sql, args } as { sql: string; args: unknown[] };
      return {
        first: async <T>(): Promise<T | null> => {
          await this.onBeforeStatement?.(sql);
          const row = (this.db.prepare(sql).get(...args) ?? null) as T | null;
          await this.onAfterStatement?.(sql);
          return row;
        },
        all: async <T>(): Promise<{ results: T[] }> => {
          await this.onBeforeStatement?.(sql);
          const rows = { results: this.db.prepare(sql).all(...args) as T[] };
          await this.onAfterStatement?.(sql);
          return rows;
        },
        run: async (): Promise<{ success: true; meta: { changes: number } }> => {
          await this.onBeforeStatement?.(sql);
          const injected = this.injectFailure?.(sql);
          if (injected) throw injected;
          const info = this.db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
        __spec: spec,
        bind: (...next: unknown[]) => make(next),
      };
    };
    return make([]);
  }
  batch(stmts: { __spec: { sql: string; args: unknown[] } }[]) {
    const run = this.chain.then(() => this.runBatch(stmts));
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async runBatch(stmts: { __spec: { sql: string; args: unknown[] } }[]) {
    this.db.exec("BEGIN");
    try {
      const results: { success: true; meta: { changes: number } }[] = [];
      for (const s of stmts) {
        await this.onBeforeStatement?.(s.__spec.sql);
        const injected = this.injectFailure?.(s.__spec.sql);
        if (injected) throw injected;
        const info = this.db.prepare(s.__spec.sql).run(...s.__spec.args);
        results.push({ success: true, meta: { changes: Number(info.changes) } });
      }
      this.db.exec("COMMIT");
      return results;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}

/** Minimal R2 bucket: conditional no-overwrite puts, byte-exact gets, and a
 *  deterministic pause gate per put ordinal (reached/released promises). */
class FakeBucket {
  objects = new Map<string, Uint8Array>();
  putCallCount = 0;
  failOnPut: number | null = null; // 1-based put ordinal that throws
  /** put ordinal to PAUSE at; the put awaits releasePause before completing. */
  pauseOnPut: number | null = null;
  private pauseResolvers: ((key: string) => void)[] = [];

  /** Resolves with the key when put #n STARTS (before its body runs). */
  waitForPut(n: number): Promise<string> {
    return new Promise((resolve) => {
      this.pendingWait = { n, resolve };
    });
  }
  private pendingWait: { n: number; resolve: (key: string) => void } | null = null;

  async put(key: string, data: ArrayBuffer | Uint8Array, opts?: { onlyIf?: { etagDoesNotMatch?: string } }) {
    this.putCallCount += 1;
    if (this.pendingWait && this.pendingWait.n === this.putCallCount) {
      const { resolve } = this.pendingWait;
      this.pendingWait = null;
      resolve(key);
    }
    if (this.pauseOnPut === this.putCallCount) {
      await this.pauseGate;
    }
    if (this.failOnPut === this.putCallCount) throw new Error("injected: R2 put failed");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (opts?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) {
      return null;
    }
    this.objects.set(key, bytes);
    return { etag: "e" };
  }
  private pauseGate: Promise<void> = Promise.resolve();
  private releasePauseFn: (() => void) | null = null;
  /** Arm the pause at put #n; returns [reached, release]. */
  armPauseAt(n: number): [Promise<string>, () => void] {
    this.pauseOnPut = n;
    const reached = this.waitForPut(n);
    let release!: () => void;
    this.pauseGate = new Promise<void>((resolve) => (release = resolve));
    this.releasePauseFn = release;
    return [reached, release];
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      body: new Blob([bytes as BlobPart]).stream(),
      httpMetadata: { contentType: "application/octet-stream" },
    };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

// ─── Fixtures (a complete, gate-clean 2026-01 month) ────────────────────────

function seedMonth(d1: SqliteD1, receiptsBucket: FakeBucket): void {
  const db = d1.db;
  // Finalized reconciliation (gate 1 anchor + manifest pointer).
  db.prepare(
    `INSERT INTO amex_reconciliations
       (id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at,
        manifest_r2_key,manifest_sha256)
     VALUES ('ar1','2026-01','finalized',0,0,0,'op','2026-01-05T00:00:00Z','mkey','msha')`,
  ).run();
  // One complete CASH receipt in the month.
  db.prepare(
    `INSERT INTO receipt_records
       (id,captured_at,captured_by,payment_path,transaction_date,merchant,amount_minor,currency,
        status,expense_category_code,original_r2_key,original_sha256,original_content_type,
        original_size_bytes,created_at,updated_at,export_statement_month,business_purpose)
     VALUES ('r1','2026-01-02T00:00:00Z','op','CASH','2026-01-10','テスト商店',500,'JPY',
        'reviewed','supplies','receipts/2026/01/r1/orig.jpg','74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0','image/jpeg',10,
        '2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','2026-01','打合せ')`,
  ).run();
  db.prepare(
    `INSERT INTO receipt_files
       (id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,
        file_size_bytes,sha256_hash,uploaded_by,uploaded_at,is_original,created_at,updated_at)
     VALUES ('f1','receipt','r1','original','receipts','receipts/2026/01/r1/orig.jpg','orig.jpg',
        'image/jpeg',10,'74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0','op','2026-01-02T00:00:00Z',1,'2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')`,
  ).run();
  receiptsBucket.objects.set("receipts/2026/01/r1/orig.jpg", new Uint8Array([1, 2, 3, 4, 5]));
}

const jsonRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/receipts/export/month", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// ─── Module mocks + route imports ────────────────────────────────────────────

let ctx: { d1: SqliteD1; archive: FakeBucket; receipts: FakeBucket };

/** Queue spy: counts enqueueExtractionJob sends (the render route's enqueue). */
const queueSends: unknown[] = [];

// Break the FIRST N 2xx-success response constructions on demand (the
// committed-but-interrupted shape). Mocked ONCE at top level.
let breakNextSuccess = 0;
if (canMockModules) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- static require keeps this mock synchronous at load time
  const { NextResponse: RealNextResponse } = require("next/server") as { NextResponse: { json: (b: unknown, i?: ResponseInit) => Response } };
  mock.module("next/server", {
    namedExports: {
      NextResponse: {
        json: (body: unknown, init?: ResponseInit) => {
          if ((init?.status ?? 200) === 200 && breakNextSuccess > 0) {
            breakNextSuccess -= 1;
            throw new Error("injected: response construction failed");
          }
          return RealNextResponse.json(body, init);
        },
      },
    },
  });
}

if (canMockModules) {
  mock.module("@/lib/cloudflare-runtime", {
    namedExports: {
      getReceiptsDb: () => ctx.d1.asD1(),
      getReceiptsArchiveBucket: () => ctx.archive,
      getReceiptsBucket: () => ctx.receipts,
      getReceiptsQueue: () => ({
        send: async (body: unknown) => {
          queueSends.push(body);
        },
      }),
      getReceiptsProcessorKey: () => "test-processor-key",
    },
  });
  mock.module("@/lib/receipts/auth", {
    namedExports: { requireReceiptsActor: async () => "op@test" },
  });
}

// tsx's CJS transform of node:test lacks `skipIf`; use a definition-time
// guard instead (same effect: tests are simply not registered when
// mock.module is unavailable).
const guardedTest = (canMockModules ? test : undefined) as unknown as typeof test;

// Route modules are imported LAZILY inside tests (top-level await is not
// supported by the CJS transform; the mocks above install first either way).
const loadExportRoute = async () => import("@/app/api/receipts/export/month/route");
const loadProofRoute = async () => import("@/app/api/receipts/[id]/proof/route");
const loadRenderRoute = async () => import("@/app/api/receipts/[id]/render/route");

function freshContext(): void {
  ctx = { d1: new SqliteD1(), archive: new FakeBucket(), receipts: new FakeBucket() };
  seedMonth(ctx.d1, ctx.receipts);
  queueSends.length = 0;
}

const runRoute = async (body: unknown) => (await loadExportRoute()).POST(jsonRequest(body));

guardedTest("route: one-shot finalize publishes under a per-build R2 namespace and promotes items", async () => {
  freshContext();
  const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: "よろしくお願いします" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { exportId: string; finalized: boolean; proofsKey: string };
  assert.equal(body.finalized, true);

  const row = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(body.exportId!) as never as Record<string, string | null>;
  assert.equal(row.status, "finalized");
  assert.equal(row.sealing_token, null, "claim cleared");
  assert.ok(row.bundle_build_id, "published build id persisted");
  // Every artifact key lives under the build namespace; the stored keys match.
  const ns = `exports/2026-01/${body.exportId}/${row.bundle_build_id}/`;
  for (const key of [row.archive_r2_key, row.manifest_r2_key, row.proofs_r2_key]) {
    assert.ok(key!.startsWith(ns), `${key} under the build namespace`);
    assert.ok(ctx.archive.objects.has(key!), `${key} uploaded`);
  }
  for (const suffix of ["-summary.csv", "-attendees.csv", "-README.txt", "-proofs.zip", "-proofs-noreceipts.zip"]) {
    assert.ok([...ctx.archive.objects.keys()].some((k) => k === `${ns}${body.exportId}${suffix}`), suffix);
  }
  // Receipt promoted + audited in the publication batch.
  const rec = ctx.d1.db.prepare(`SELECT status, exported_month FROM receipt_records WHERE id='r1'`).get() as never as Record<string, string>;
  assert.equal(rec.status, "exported");
  assert.equal(rec.exported_month, "2026-01");
  const actions = (ctx.d1.db.prepare(`SELECT action FROM receipt_audit_log ORDER BY rowid`).all() as never as { action: string }[]).map((a) => a.action);
  assert.ok(actions.includes("export.finalized"));
  assert.ok(actions.includes("receipt.exported"));
});

guardedTest("A1 edits fenced while a build is in flight; concurrent finalizer gets 409; resumed build seals", async () => {
  freshContext();
  // Pause the route right after claim acquisition (the file-manifest read).
  let releasePause!: () => void;
  const gate = new Promise<void>((resolve) => (releasePause = resolve));
  let paused = false;
  ctx.d1.onBeforeStatement = async (sql) => {
    if (!paused && sql.includes("FROM receipt_files") && sql.includes("object_id IN")) {
      paused = true;
      await gate;
    }
  };

  const inFlight = runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  await new Promise((r) => setTimeout(r, 30)); // let it reach the pause

  // Protected edits under the live claim are rejected by SQL.
  assert.throws(() => ctx.d1.db.prepare(`UPDATE receipt_records SET amount_minor=999 WHERE id='r1'`).run(), /DZ_SEAL_CLAIM_ACTIVE/);
  assert.throws(
    () => ctx.d1.db.prepare(`INSERT INTO receipt_settings (key,value,updated_at,updated_by) VALUES ('export_block_on_warnings','true','t','a')`).run(),
    /DZ_SEAL_CLAIM_ACTIVE/,
  );
  // A concurrent finalizer cannot even acquire.
  const loser = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  assert.equal(loser.status, 409);

  releasePause();
  const res = await inFlight;
  assert.equal(res.status, 200);
  ctx.d1.onBeforeStatement = null;
});

guardedTest("A7 an already-expired claim does not wedge the month: edits flow and a fresh build seals", async () => {
  freshContext();
  const db = ctx.d1.asD1();
  // A prior attempt whose lease has already expired (the suspended-builder
  // state ten minutes later).
  const dbMod = await import("@/lib/receipts/db");
  const lockMod = await loadLock();
  const expiredId = await dbMod.createExport("2026-01", "op", db);
  await lockMod.acquireSealClaim(db, { exportId: expiredId, finalize: false, leaseSeconds: -5 });
  // Edits flow — every predicate ignores the expired lease.
  ctx.d1.db.prepare(`UPDATE receipt_records SET business_purpose='updated during expiry' WHERE id='r1'`).run();
  // A fresh build acquires over the expired claim and seals.
  const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  assert.equal(res.status, 200);
});

guardedTest("A9 interruption before/at puts: 500, previous published draft intact, claim released, retry succeeds", async () => {
  freshContext();
  // Establish a previously published draft build.
  const first = await runRoute({ month: "2026-01", finalize: false });
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { exportId: string };
  const before = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(firstBody.exportId) as never as Record<string, unknown>;
  const itemsBefore = ctx.d1.db.prepare(`SELECT item_id FROM receipt_export_items WHERE export_id=? ORDER BY item_id`, ).all(firstBody.exportId);

  // Fail the first archive put of the NEXT build.
  ctx.archive.failOnPut = ctx.archive.putCallCount + 1; // the NEXT put
  const failed = await runRoute({ month: "2026-01", finalize: false });
  assert.equal(failed.status, 500);
  ctx.archive.failOnPut = null;

  const after = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(firstBody.exportId) as never as Record<string, unknown>;
  for (const col of ["archive_r2_key", "manifest_r2_key", "bundle_built_at", "bundle_build_id", "status"]) {
    assert.equal(after[col], before[col], `${col} survives the interrupted build`);
  }
  assert.deepEqual(
    ctx.d1.db.prepare(`SELECT item_id FROM receipt_export_items WHERE export_id=? ORDER BY item_id`).all(firstBody.exportId),
    itemsBefore,
    "previous published item set survives",
  );
  assert.equal(after.sealing_token, null, "claim released after a known failure");
  // Retry works (a new build namespace — old objects retained, never overwritten).
  const retry = await runRoute({ month: "2026-01", finalize: false });
  assert.equal(retry.status, 200);
  const retryRow = ctx.d1.db.prepare(`SELECT bundle_build_id FROM receipt_exports WHERE id=?`).get(firstBody.exportId) as never as { bundle_build_id: string };
  const beforeRow = before as unknown as { bundle_build_id: string };
  assert.notEqual(retryRow.bundle_build_id, beforeRow.bundle_build_id, "each attempt gets a fresh build namespace");
});

guardedTest("A9 committed-but-interrupted: lost success response reports the published identity, nothing is cleaned up", async () => {
  freshContext();
  breakNextSuccess = 1; // break ONLY the first success response
  try {
    const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { outcome: string; finalized: boolean; buildId: string };
    assert.equal(body.outcome, "published");
    assert.equal(body.finalized, true);
    const row = ctx.d1.db.prepare(`SELECT status, bundle_build_id, sealing_token FROM receipt_exports WHERE export_month='2026-01'`).get() as never as Record<string, string | null>;
    assert.equal(row.status, "finalized", "the seal committed");
    assert.equal(row.bundle_build_id, body.buildId);
    assert.equal(row.sealing_token, null);
    // No cleanup deleted possibly-committed objects.
    assert.ok(ctx.archive.objects.size >= 7, "published objects retained");
  } finally {
    breakNextSuccess = 0;
  }
});

guardedTest("A10 a blocked one-shot (422) keeps its explicit decision and releases the claim", async () => {
  freshContext();
  // Add an UNKNOWN receipt dated in the month → payment_path_unknown blocker.
  ctx.d1.db.prepare(
    `INSERT INTO receipt_records
       (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,
        original_sha256,original_content_type,original_size_bytes,created_at,updated_at)
     VALUES ('rX','2026-01-03T00:00:00Z','op','UNKNOWN','2026-01-11','captured','kx','shx','image/jpeg',1,'t','t')`,
  ).run();
  const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: "この月のメッセージ" });
  assert.equal(res.status, 422);
  const row = ctx.d1.db.prepare(`SELECT operator_message, operator_message_updated_at, sealing_token, bundle_build_id FROM receipt_exports WHERE export_month='2026-01'`).get() as never as Record<string, string | null>;
  assert.equal(row.operator_message, "この月のメッセージ", "explicit decision remains saved");
  assert.ok(row.operator_message_updated_at, "decision timestamp recorded");
  assert.equal(row.sealing_token, null, "claim released on the gate-failure path");
  assert.equal(row.bundle_build_id, null, "nothing published");
  assert.equal(ctx.archive.objects.size, 0, "no artifacts uploaded before the gate");
});

guardedTest("A12 downloads resolve the published build namespace; legacy rows keep export-ID keys", async () => {
  freshContext();
  const { resolveBundleDownload } = await import("@/lib/receipts/export");
  const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  const { exportId } = (await res.json()) as { exportId: string };
  const row = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(exportId) as never as Record<string, string | null>;
  const finalizedRecord = {
    id: exportId,
    archive_r2_key: row.archive_r2_key,
    manifest_r2_key: row.manifest_r2_key,
    proofs_r2_key: row.proofs_r2_key,
    payment_due_date: row.payment_due_date,
    bundle_build_id: row.bundle_build_id,
  };
  for (const file of ["receipts", "manifest", "summary", "attendees", "readme", "proofs", "amex", "cash"] as const) {
    const r = resolveBundleDownload({ month: "2026-01", file, draft: false, draftRecord: null, finalizedRecord });
    assert.ok(r.ok, `${file} resolves`);
    if (r.ok) assert.ok(ctx.archive.objects.has(r.r2Key) || file === "amex" || file === "cash", `${file} key exists in R2 (${r.r2Key})`);
  }
  // A legacy row (NULL build id) resolves the OLD export-ID paths.
  const legacyRecord = { ...finalizedRecord, bundle_build_id: null };
  const legacy = resolveBundleDownload({ month: "2026-01", file: "summary", draft: false, draftRecord: null, finalizedRecord: legacyRecord });
  assert.ok(legacy.ok && legacy.r2Key === `exports/2026-01/${exportId}-summary.csv`, "legacy rows keep export-ID key paths");
});

// ─── Acceptance 11: proof/render routes — versioned, immutable, fenced ──────

guardedTest("A11 proof upload: versioned key, atomic manifest switch; fenced during a build claim with the old manifest intact", async () => {
  freshContext();
  const req = (_body?: never) =>
    new Request("http://localhost/api/receipts/r1/proof", {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-receipts-processor-key": "test-processor-key" },
      body: new Uint8Array([9, 9, 9]),
    });

  // Admitted publication: versioned key, manifest replaced, audit written.
  const ok = await (await loadProofRoute()).POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { r2Key: string };
  assert.match(okBody.r2Key, /^receipts\/r1\/proof-[0-9a-f-]+\.(jpg|pdf)$/, "versioned immutable key");
  assert.ok(ctx.receipts.objects.has(okBody.r2Key));
  const manifest = ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_files WHERE object_type='receipt' AND object_id='r1' AND role='proof_copy'`).get() as never as { n: number };
  assert.equal(manifest.n, 1, "exactly one current proof_copy row");

  // Fenced: an active build claim on the month rejects the D1 switch; the old
  // manifest survives and the new object is unreferenced bytes.
  const db = ctx.d1.asD1();
  const exportId = await (await import("@/lib/receipts/db")).createExport("2026-01", "op", db);
  await (await loadLock()).acquireSealClaim(db, { exportId, finalize: false });
  const fenced = await (await loadProofRoute()).POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(fenced.status, 409);
  const after = ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_files WHERE object_type='receipt' AND object_id='r1' AND role='proof_copy'`).get() as never as { n: number };
  assert.equal(after.n, 1, "old manifest row survived the fence");
  const r2Key = ctx.d1.db.prepare(`SELECT r2_key FROM receipt_files WHERE object_type='receipt' AND object_id='r1' AND role='proof_copy'`).get() as never as { r2_key: string };
  assert.equal(r2Key.r2_key, okBody.r2Key, "current manifest still points at the last admitted proof");
});

guardedTest("A11 render upload: fenced during a claim (needs_render untouched, no queue work); admitted otherwise", async () => {
  freshContext();
  // Make r1 a render-pending email_body receipt.
  ctx.d1.db.prepare(`UPDATE receipt_records SET needs_render=1, source_type='email_body' WHERE id='r1'`).run();
  const req = () =>
    new Request("http://localhost/api/receipts/r1/render", {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-receipts-processor-key": "test-processor-key" },
      body: new Uint8Array([7, 7]),
    });

  const db = ctx.d1.asD1();
  const exportId = await (await import("@/lib/receipts/db")).createExport("2026-01", "op", db);
  await (await loadLock()).acquireSealClaim(db, { exportId, finalize: false });
  const fenced = await (await loadRenderRoute()).POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(fenced.status, 409);
  let row = ctx.d1.db.prepare(`SELECT needs_render, extraction_r2_key FROM receipt_records WHERE id='r1'`).get() as never as Record<string, unknown>;
  assert.equal(row.needs_render, 1, "fence left the render-pending state intact");
  assert.equal(row.extraction_r2_key, null);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_files WHERE object_id='r1' AND role='processed'`).get() as { n: number }).n, 0, "no manifest row for a rejected render");

  // Release (simulate lease expiry via a fresh acquirable state) and admit.
  await (await loadLock()).releaseSealClaim(db, exportId, (ctx.d1.db.prepare(`SELECT sealing_token FROM receipt_exports WHERE id=?`).get(exportId) as never as { sealing_token: string }).sealing_token);
  const ok = await (await loadRenderRoute()).POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { r2Key: string; enqueued: boolean };
  assert.match(okBody.r2Key, /^receipts\/r1\/rendered-[0-9a-f-]+\.(pdf|png)$/, "versioned immutable key");
  row = ctx.d1.db.prepare(`SELECT needs_render, extraction_r2_key FROM receipt_records WHERE id='r1'`).get() as never as Record<string, unknown>;
  assert.equal(row.needs_render, 0, "admitted render cleared needs_render");
  assert.equal(row.extraction_r2_key, okBody.r2Key);
  assert.equal(okBody.enqueued, true, "queue spy binding — admitted render enqueues");
});

// ─── Review round 2: B1 message race, B9 typed CAS, B11 uncertain ack ───────

guardedTest("R2-B1 a message decision saved just before acquisition SURVIVES the rebuild", async () => {
  freshContext();
  const dbMod = await import("@/lib/receipts/db");
  const db = ctx.d1.asD1();
  const id = await dbMod.createExport("2026-01", "op", db);
  ctx.d1.db.prepare(`UPDATE receipt_exports SET operator_message='old', operator_message_updated_at='2026-01-01T00:00:00Z' WHERE id=?`).run(id);
  // A message PATCH commits in the window between createExport's read and the
  // acquisition SQL (the claim trigger correctly allows it — the claim does
  // not exist yet).
  let injected = false;
  ctx.d1.onBeforeStatement = async (sql) => {
    if (!injected && sql.includes("SET sealing_token = ?")) {
      injected = true;
      ctx.d1.db.prepare(`UPDATE receipt_exports SET operator_message='new decision', operator_message_updated_at='2026-01-02T00:00:00Z' WHERE id=?`).run(id);
    }
  };
  const res = await runRoute({ month: "2026-01", finalize: false });
  ctx.d1.onBeforeStatement = null;
  assert.equal(res.status, 200);
  const row = ctx.d1.db.prepare(`SELECT operator_message, operator_message_updated_at FROM receipt_exports WHERE id=?`).get(id) as never as Record<string, string | null>;
  assert.equal(row.operator_message, "new decision", "the pre-acquisition save survives — published from the post-acquisition reload");
  assert.equal(row.operator_message_updated_at, "2026-01-02T00:00:00Z", "publication never rewrites the decision timestamp");
});

guardedTest("R2-B9 a lost publication CAS surfaces as a typed 409 conflict, not a raw NOT NULL 500", async () => {
  freshContext();
  // Steal the claim away right before the publication batch's CAS runs.
  let stolen = false;
  ctx.d1.onBeforeStatement = async (sql) => {
    if (!stolen && sql.includes("DELETE FROM receipt_export_items")) {
      stolen = true;
      ctx.d1.db.prepare(`UPDATE receipt_exports SET sealing_token=NULL, sealing_expires_at=NULL`).run();
    }
  };
  const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  ctx.d1.onBeforeStatement = null;
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /could not be published/i);
  assert.ok(!/NOT NULL/i.test(body.error), "the driver's constraint text must not leak");
  const row = ctx.d1.db.prepare(`SELECT status, bundle_build_id FROM receipt_exports WHERE export_month='2026-01'`).get() as never as Record<string, string | null>;
  assert.equal(row.status, "draft", "nothing sealed by the losing attempt");
  assert.equal(row.bundle_build_id, null);
});

guardedTest("R2-B11 committed batch + unreadable identity reread → explicit unconfirmed outcome, NO claim release", async () => {
  freshContext();
  const originalBatch = ctx.d1.batch.bind(ctx.d1);
  let committed = false;
  let releaseAttempted = false;
  ctx.d1.batch = (async (stmts: { __spec: { sql: string; args: unknown[] } }[]) => {
    const result = await originalBatch(stmts);
    if (stmts.some((s) => s.__spec.sql.includes("SET archive_r2_key"))) {
      committed = true;
      throw new Error("injected lost D1 acknowledgement");
    }
    return result;
  }) as typeof ctx.d1.batch;
  ctx.d1.onBeforeStatement = async (sql) => {
    if (committed && sql.includes("SELECT * FROM receipt_exports WHERE id")) {
      throw new Error("injected identity reread unavailable");
    }
    if (committed && sql.includes("SET sealing_token = NULL")) {
      releaseAttempted = true;
    }
  };
  const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  ctx.d1.onBeforeStatement = null;
  assert.equal((ctx.d1.db.prepare(`SELECT status FROM receipt_exports`).get() as never as { status: string }).status, "finalized", "the seal DID commit");
  assert.equal(res.status, 503);
  const body = (await res.json()) as { outcome: string };
  assert.equal(body.outcome, "unconfirmed");
  assert.equal(releaseAttempted, false, "the uncertain path must not run the known-failure release");
  // The committed row keeps its published identity for the reload.
  const row = ctx.d1.db.prepare(`SELECT bundle_build_id, sealing_token FROM receipt_exports`).get() as never as Record<string, string | null>;
  assert.ok(row.bundle_build_id);
  assert.equal(row.sealing_token, null, "publication cleared the claim");
});

guardedTest("R2-B11 unclassified batch error with a non-matching reread → unconfirmed (never assumed rolled back)", async () => {
  freshContext();
  ctx.d1.batch = (async (_stmts: { __spec: { sql: string; args: unknown[] } }[]) => {
    // Ambiguous transaction error with no recognizable signature — the
    // uncertain-acknowledgement path must engage regardless of rollback.
    throw new Error("injected ambiguous transaction error");
  }) as typeof ctx.d1.batch;
  const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { outcome: string };
  assert.equal(body.outcome, "unconfirmed");
  const row = ctx.d1.db.prepare(`SELECT status, sealing_token FROM receipt_exports`).get() as never as Record<string, string | null>;
  assert.equal(row.status, "draft");
  assert.ok(row.sealing_token, "lease left to expire on its own — no release on the uncertain path");
});

// ─── Acceptance 1/9: per-put writer matrix (deterministic reached/released) ──

guardedTest("R2-A1 writer matrix fenced at EVERY archive-put boundary; unmatched AMEX stays allowed", async () => {
  // The cash-only fixture month performs 8 puts: receipts CSV, cash recon,
  // proofs ZIP, NoReceipts ZIP, manifest, summary, attendees, README.
  const PUT_COUNT = 8;
  for (let k = 1; k <= PUT_COUNT; k += 1) {
    freshContext();
    // An UNMATCHED AMEX receipt dated in the month must stay editable (B10).
    ctx.d1.db.prepare(
      `INSERT INTO receipt_records
         (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,
          original_sha256,original_content_type,original_size_bytes,created_at,updated_at)
       VALUES ('amex1','2026-01-04T00:00:00Z','op','AMEX','2026-01-12','captured','kam','sh','image/jpeg',1,'t','t')`,
    ).run();

    const [reached, release] = ctx.archive.armPauseAt(k);
    const inFlight = runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
    await reached; // deterministic: the build holds the claim at put #k

    const matrix: Array<[string, string]> = [
      ["amount", `UPDATE receipt_records SET amount_minor=999 WHERE id='r1'`],
      ["category", `UPDATE receipt_records SET expense_category_code='travel_transportation' WHERE id='r1'`],
      ["date", `UPDATE receipt_records SET transaction_date='2026-01-11' WHERE id='r1'`],
      ["payment path", `UPDATE receipt_records SET payment_path='DIGITAL' WHERE id='r1'`],
      ["receipt identity rename", `UPDATE receipt_records SET id='r1-renamed' WHERE id='r1'`],
      ["membership", `UPDATE receipt_records SET export_statement_month='2026-02' WHERE id='r1'`],
      ["extraction_state", `UPDATE receipt_records SET extraction_state='processed' WHERE id='r1'`],
      ["attendee add", `INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('at','r1','x','t')`],
      ["receipt delete", `DELETE FROM receipt_records WHERE id='r1'`],
      ["UNKNOWN insert dated in month", `INSERT INTO receipt_records (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at) VALUES ('u1','t','a','UNKNOWN','2026-01-13','captured','ku','s','image/jpeg',1,'t','t')`],
      ["line insert in month", `INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at) VALUES ('L1','2026-01','2026-01-14','m',1,'JPY','unmatched','{}','t')`],
    ];
    for (const [label, stmt] of matrix) {
      // The fixture month's reconciliation is finalized, so the line insert
      // may trip the strict RECON seal instead of the claim guard — either
      // way the write is fenced by SQL authority.
      assert.throws(() => ctx.d1.db.prepare(stmt).run(), /DZ_SEAL_(CLAIM_ACTIVE|RECON_LOCKED)/, `put #${k}: ${label} must be fenced`);
    }
    // Negative scope: the unmatched AMEX receipt is editable through the claim.
    ctx.d1.db.prepare(`UPDATE receipt_records SET amount_minor=777 WHERE id='amex1'`).run();

    release();
    const res = await inFlight;
    assert.equal(res.status, 200, `put #${k}: the build completes after the pause`);
  }
});

// ─── Acceptance 2: a writer paused AFTER its JS prechecks, resumed post-seal ──

guardedTest("R3-A2 pre-admitted PATCH: parked AFTER its unlocked precheck read, mutation SQL attempted and rejected post-seal", async () => {
  freshContext();
  const patchRoute = await import("@/app/api/receipts/[id]/route");
  const patchReq = () =>
    new Request("http://localhost/api/receipts/r1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountMinor: 4242 }),
    });

  // Deterministic gates:
  //  - `unlocked` resolves when the PATCH's LAST precheck read (the export-lock
  //    SELECT in assertTransactionMonthEditable) has EXECUTED and its result is
  //    captured — the shim's onAfterStatement fires after the row is read, so
  //    the PATCH is suspended with its prechecks PASSED and its batch unissued.
  //  - `updateAttempted` flips when the batch's receipt UPDATE statement is
  //    issued (onBeforeStatement inside the batch) — proving the mutation SQL
  //    was attempted, not short-circuited by a JS precheck.
  let unlockedResolve!: () => void;
  const unlocked = new Promise<void>((r) => (unlockedResolve = r));
  let parkResolve!: () => void;
  const park = new Promise<void>((r) => (parkResolve = r));
  let precheckReadDone = false;
  let updateAttempted = false;
  ctx.d1.onAfterStatement = async (sql) => {
    if (
      !precheckReadDone &&
      /SELECT CASE/i.test(sql) &&
      sql.includes("receipt_exports") &&
      sql.includes("AS locked")
    ) {
      precheckReadDone = true;
      unlockedResolve();
      // Hold the PATCH here (result captured, batch not yet issued) while the
      // seal below completes against the now-unprotected month; resuming is a
      // deterministic parkResolve() (the shim's first() promise cannot resolve
      // until this hook returns, so the batch is never issued while parked).
      await park;
    }
  };
  ctx.d1.onBeforeStatement = async (sql) => {
    if (
      !updateAttempted &&
      /UPDATE receipt_records SET /.test(sql) &&
      sql.includes("amount_minor")
    ) {
      updateAttempted = true;
    }
  };

  const patchInFlight = patchRoute.PATCH(patchReq(), { params: Promise.resolve({ id: "r1" }) });
  await unlocked; // prechecks passed, result captured

  const sealed = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  assert.equal(sealed.status, 200);

  // Resume the parked PATCH: its batch now runs against the sealed month.
  parkResolve();
  const patchRes = await patchInFlight;
  ctx.d1.onBeforeStatement = null;
  assert.equal(patchRes.status, 409, "SQL authority rejects the resumed writer");
  assert.ok(updateAttempted, "the mutation UPDATE was actually attempted (not stopped by the JS precheck)");
  const amt = (ctx.d1.db.prepare(`SELECT amount_minor FROM receipt_records WHERE id='r1'`).get() as never as { amount_minor: number }).amount_minor;
  assert.equal(amt, 500, "the sealed amount is unchanged");
});

guardedTest("R2-A2 the same pre-admitted writer succeeds once the claim EXPIRED (no claim to fence)", async () => {
  freshContext();
  const db = ctx.d1.asD1();
  const dbMod = await import("@/lib/receipts/db");
  const lockMod = await import("@/lib/receipts/month-lock");
  const id = await dbMod.createExport("2026-01", "op", db);
  // An already-expired lease (the suspended-builder state) does not fence.
  await lockMod.acquireSealClaim(db, { exportId: id, finalize: false, leaseSeconds: -5 });
  ctx.d1.db.prepare(`UPDATE receipt_records SET amount_minor=555 WHERE id='r1'`).run();
  const amt = (ctx.d1.db.prepare(`SELECT amount_minor FROM receipt_records WHERE id='r1'`).get() as never as { amount_minor: number }).amount_minor;
  assert.equal(amt, 555);
});

// ─── Acceptance 5: the ACTUAL hardDeleteReceipt helper under a claim ─────────

guardedTest("R2-A5 hardDeleteReceipt under a claim throws and leaves receipt + children + audit intact", async () => {
  freshContext();
  const dbMod = await import("@/lib/receipts/db");
  // The line lives in an OPEN month (2026-01's reconciliation is finalized in
  // this fixture — a line there would hit the strict seal, a different guard).
  ctx.d1.db.prepare(`INSERT INTO amex_statement_lines (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id) VALUES ('L1','2026-02','2026-02-14','m',1,'JPY','confirmed','{}','t','r1')`).run();
  ctx.d1.db.prepare(`INSERT INTO receipt_attendees (id,receipt_id,attendee_name,created_at) VALUES ('at1','r1','x','t')`).run();
  const db = ctx.d1.asD1();
  const exportId = await dbMod.createExport("2026-01", "op", db);
  await (await loadLock()).acquireSealClaim(db, { exportId, finalize: false });
  await assert.rejects(
    dbMod.hardDeleteReceipt("r1", "op", "test"),
    (err: unknown) => /DZ_SEAL_CLAIM_ACTIVE/.test((err as Error).message),
  );
  // Everything intact — no R2-then-D1 ordering to worry about either.
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_records WHERE id='r1'`).get() as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_attendees WHERE receipt_id='r1'`).get() as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_files WHERE object_id='r1'`).get() as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM amex_statement_lines WHERE matched_receipt_id='r1'`).get() as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_audit_log`).get() as never as { n: number }).n, 1, "only export.created — no delete audit");
});

// ─── Acceptance 9: warning failure cannot turn a confirmed seal into failure ──

guardedTest("R2-A9 an earlier-month warning failure stays a warning on a confirmed finalize", async () => {
  freshContext();
  ctx.d1.onBeforeStatement = async (sql) => {
    if (sql.includes("SELECT DISTINCT asl.statement_month") && sql.includes("LEFT JOIN receipt_exports")) {
      throw new Error("injected: warning query failed");
    }
  };
  const res = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  ctx.d1.onBeforeStatement = null;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { warnings: string[]; finalized: boolean };
  assert.equal(body.finalized, true);
  assert.ok(body.warnings.some((w) => /could not run/i.test(w)), "the failure is surfaced as a warning");
  assert.equal((ctx.d1.db.prepare(`SELECT status FROM receipt_exports`).get() as never as { status: string }).status, "finalized");
});

// ─── Acceptance 8/B8: transactional export deletion + plan→acquire→execute race ──

guardedTest("R2-B8 plan→acquire→execute race: the claim acquired after planning ABORTS the deletion; objects retained; retry after release succeeds", async () => {
  freshContext();
  const { planExportDeletion, executeExportDeletion } = await import("@/lib/receipts/export-deletion");
  const db = ctx.d1.asD1();

  // Publish a draft build (its R2 objects are the deletion plan's targets).
  const build = await runRoute({ month: "2026-01", finalize: false });
  const { exportId } = (await build.json()) as { exportId: string };
  const rowBefore = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(exportId) as never as Record<string, unknown>;
  const objectsBefore = new Map(ctx.archive.objects);

  const plan = planExportDeletion(
    { exportId, month: "2026-01", legalHoldException: "test cleanup" },
    { exportRow: rowBefore as never, deliveries: [], nowEpochSeconds: Math.floor(Date.now() / 1000) },
  );
  assert.ok(plan.ok);

  // A rebuild claim lands between planning and execution.
  await (await loadLock()).acquireSealClaim(db, { exportId, finalize: false });
  await assert.rejects(
    executeExportDeletion(db, {
      exportId,
      month: "2026-01",
      plannedStatus: "draft",
      actor: "delete-sealed-export.ts",
      nowIso: new Date().toISOString(),
      auditId: "audit-1",
      assertId: "assert-1",
      auditValueJson: (plan.ok ? plan.plan.audit.newValueJson : "{}"),
      plannedIdentity: {
        bundleBuildId: (rowBefore.bundle_build_id as string | null) ?? null,
        archiveKey: (rowBefore.archive_r2_key as string | null) ?? null,
        manifestKey: (rowBefore.manifest_r2_key as string | null) ?? null,
        proofsKey: (rowBefore.proofs_r2_key as string | null) ?? null,
      },
    }),
    (err: unknown) => /DZ_SEAL|constraint|NOT NULL/i.test((err as Error).message),
    "the guarded transaction aborts (marker refused the live claim)",
  );
  // NOTHING deleted — rows, items, and every R2 object retained.
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports WHERE id=?`).get(exportId) as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_audit_log WHERE action='export.deleted'`).get() as never as { n: number }).n, 0, "no stray marker survived the abort");
  assert.equal(ctx.archive.objects.size, objectsBefore.size);

  // After the claim is released, the same plan executes transactionally.
  const token = (ctx.d1.db.prepare(`SELECT sealing_token FROM receipt_exports WHERE id=?`).get(exportId) as never as { sealing_token: string }).sealing_token;
  await (await loadLock()).releaseSealClaim(db, exportId, token);
  const executed = await executeExportDeletion(db, {
    exportId,
    month: "2026-01",
    plannedStatus: "draft",
    actor: "delete-sealed-export.ts",
    nowIso: new Date().toISOString(),
    auditId: "audit-2",
    assertId: "assert-2",
    auditValueJson: plan.ok ? plan.plan.audit.newValueJson : "{}",
      plannedIdentity: {
        bundleBuildId: (rowBefore.bundle_build_id as string | null) ?? null,
        archiveKey: (rowBefore.archive_r2_key as string | null) ?? null,
        manifestKey: (rowBefore.manifest_r2_key as string | null) ?? null,
        proofsKey: (rowBefore.proofs_r2_key as string | null) ?? null,
      },
  });
  assert.equal(executed.exportRowsDeleted, 1);
  assert.equal(executed.markerWritten, true);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports WHERE id=?`).get(exportId) as never as { n: number }).n, 0);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items WHERE export_id=?`).get(exportId) as never as { n: number }).n, 0);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_audit_log WHERE action='export.deleted' AND object_id=?`).get(exportId) as never as { n: number }).n, 1);
});

guardedTest("R2-B8 a FINALIZED export refuses deletion without the marker (guards) and deletes transactionally with it", async () => {
  freshContext();
  const { executeExportDeletion } = await import("@/lib/receipts/export-deletion");
  const db = ctx.d1.asD1();
  const build = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  const { exportId } = (await build.json()) as { exportId: string };
  const objectsBefore = ctx.archive.objects.size;

  // Out-of-band attempt (no marker): the items/parent guards abort.
  await assert.rejects(
    db.batch([
      db.prepare(`DELETE FROM receipt_export_items WHERE export_id = ?`).bind(exportId),
      db.prepare(`DELETE FROM receipt_exports WHERE id = ?`).bind(exportId),
    ]),
    (err: unknown) => /DZ_SEAL|constraint/i.test((err as Error).message),
  );
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports WHERE id=?`).get(exportId) as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items WHERE export_id=?`).get(exportId) as never as { n: number }).n, 1);
  assert.equal(ctx.archive.objects.size, objectsBefore, "R2 untouched by the refused D1 attempt");

  const finRow = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(exportId) as never as Record<string, unknown>;
  const executed = await executeExportDeletion(db, {
    exportId,
    month: "2026-01",
    plannedStatus: "finalized",
    actor: "delete-sealed-export.ts",
    nowIso: new Date().toISOString(),
    auditId: "audit-3",
    assertId: "assert-3",
    auditValueJson: "{}",
    plannedIdentity: {
      bundleBuildId: (finRow.bundle_build_id as string | null) ?? null,
      archiveKey: (finRow.archive_r2_key as string | null) ?? null,
      manifestKey: (finRow.manifest_r2_key as string | null) ?? null,
      proofsKey: (finRow.proofs_r2_key as string | null) ?? null,
    },
  });
  assert.equal(executed.exportRowsDeleted, 1);
  assert.equal(executed.markerWritten, true);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports WHERE id=?`).get(exportId) as never as { n: number }).n, 0);
});

// ─── Acceptance 12: draft ZIP variants + prior finalized revision under correction ──

guardedTest("R2-A12 both draft ZIP variants resolve under the new build namespace; the prior sealed revision stays downloadable while a correction draft is open", async () => {
  freshContext();
  const { resolveBundleDownload } = await import("@/lib/receipts/export");
  const correctionMod = await import("@/app/api/receipts/export/[month]/route");

  // Revision 1: sealed.
  const sealed = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  const rev1 = (await sealed.json()) as { exportId: string };
  const rev1Row = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(rev1.exportId) as never as Record<string, string | null>;
  const rev1ProofsKey = rev1Row.proofs_r2_key;

  // Open a correction revision (actual route).
  const correction = await correctionMod.POST(
    new Request("http://localhost/api/receipts/export/2026-01?correction=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correctionReason: "late receipt" }),
    }),
    { params: Promise.resolve({ month: "2026-01" }) },
  );
  assert.equal(correction.status, 201);
  const { exportId: rev2Id } = (await correction.json()) as { exportId: string };

  // Rebuild the correction draft → draft ZIP variants under ITS build namespace.
  const rebuilt = await runRoute({ month: "2026-01", finalize: false });
  assert.equal(rebuilt.status, 200);
  const rev2Row = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(rev2Id) as never as Record<string, string | null>;
  const draftRecord = {
    id: rev2Id,
    archive_r2_key: rev2Row.archive_r2_key,
    manifest_r2_key: rev2Row.manifest_r2_key,
    proofs_r2_key: rev2Row.proofs_r2_key,
    bundle_built_at: rev2Row.bundle_built_at,
    payment_due_date: rev2Row.payment_due_date,
    bundle_build_id: rev2Row.bundle_build_id,
  };
  for (const file of ["draft_wr", "draft_nr"] as const) {
    const r = resolveBundleDownload({ month: "2026-01", file, draft: true, draftRecord, finalizedRecord: null });
    assert.ok(r.ok, `${file} resolves`);
    if (r.ok) {
      assert.ok(ctx.archive.objects.has(r.r2Key), `${file} object exists (${r.r2Key})`);
      assert.ok(r.r2Key.includes(`/${rev2Row.bundle_build_id}/`), `${file} under the new build namespace`);
    }
  }

  // The PRIOR sealed revision resolves unchanged while the correction is open.
  const prior = resolveBundleDownload({
    month: "2026-01",
    file: "proofs",
    draft: false,
    draftRecord: null,
    finalizedRecord: {
      id: rev1.exportId,
      archive_r2_key: rev1Row.archive_r2_key,
      manifest_r2_key: rev1Row.manifest_r2_key,
      proofs_r2_key: rev1Row.proofs_r2_key,
      payment_due_date: rev1Row.payment_due_date,
      bundle_build_id: rev1Row.bundle_build_id,
    },
  });
  assert.ok(prior.ok && prior.r2Key === rev1ProofsKey, "prior sealed revision keeps its exact stored key");
});

// ─── Acceptance 13: correction sequence via actual routes ────────────────────

guardedTest("R2-A13 correction matrix: sealed edit refused → correction draft releases → rebuild claim re-fences → prior bytes unchanged", async () => {
  freshContext();
  const patchRoute = await import("@/app/api/receipts/[id]/route");
  const correctionMod = await import("@/app/api/receipts/export/[month]/route");
  const patchReq = (amount: number) =>
    new Request("http://localhost/api/receipts/r1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountMinor: amount }),
    });

  const sealed = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  assert.equal(sealed.status, 200);
  const rev1 = (await sealed.json()) as { exportId: string };
  const rev1Row = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(rev1.exportId) as never as Record<string, string | null>;
  const keysBefore = [...ctx.archive.objects.keys()].sort();

  // Exported receipt edit refused (sealed month, no draft).
  const refused = await patchRoute.PATCH(patchReq(1), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(refused.status, 409);

  // Open the correction (actual route) → the same edit is released.
  const correction = await correctionMod.POST(
    new Request("http://localhost/api/receipts/export/2026-01?correction=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ correctionReason: "amount fix" }),
    }),
    { params: Promise.resolve({ month: "2026-01" }) },
  );
  assert.equal(correction.status, 201);
  const allowed = await patchRoute.PATCH(patchReq(600), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(allowed.status, 200);

  // A rebuild claim on the correction draft re-fences the edit.
  const db = ctx.d1.asD1();
  const dbMod2 = await import("@/lib/receipts/db");
  const rev2Id = await dbMod2.createExport("2026-01", "op", db); // reuses the open correction draft
  await (await loadLock()).acquireSealClaim(db, { exportId: rev2Id, finalize: false });
  const refenced = await patchRoute.PATCH(patchReq(700), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(refenced.status, 409);
  const amt = (ctx.d1.db.prepare(`SELECT amount_minor FROM receipt_records WHERE id='r1'`).get() as never as { amount_minor: number }).amount_minor;
  assert.equal(amt, 600, "the edit inside the claim did not land");

  // Prior sealed revision bytes are untouched throughout.
  assert.deepEqual([...ctx.archive.objects.keys()].sort().slice(0, keysBefore.length), keysBefore);
  assert.equal(rev1Row.proofs_r2_key, (ctx.d1.db.prepare(`SELECT proofs_r2_key FROM receipt_exports WHERE id=?`).get(rev1.exportId) as never as { proofs_r2_key: string }).proofs_r2_key);
});

// ─── Acceptance 11: manifest-insert rollback + queue spy ─────────────────────

guardedTest("R2-A11 proof manifest-insert failure rolls the switch back; the old manifest survives and the new object is unreferenced", async () => {
  freshContext();
  const proofRoute = await loadProofRoute();
  const req = () =>
    new Request("http://localhost/api/receipts/r1/proof", {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-receipts-processor-key": "test-processor-key" },
      body: new Uint8Array([9, 9, 9]),
    });

  // First, an admitted proof (the current manifest).
  const ok = await proofRoute.POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { r2Key: string };

  // Now fail the manifest INSERT inside the batch.
  ctx.d1.injectFailure = (sql: string) =>
    /INSERT INTO receipt_files[\s\S]*proof_copy/.test(sql) ? new Error("injected manifest insert failure") : null;
  const failed = await proofRoute.POST(req(), { params: Promise.resolve({ id: "r1" }) });
  ctx.d1.injectFailure = null;
  assert.equal(failed.status, 500);
  const current = ctx.d1.db.prepare(`SELECT r2_key FROM receipt_files WHERE object_type='receipt' AND object_id='r1' AND role='proof_copy'`).get() as never as { r2_key: string };
  assert.equal(current.r2_key, okBody.r2Key, "old manifest row survived the rollback");
});

guardedTest("R2-A11 queue spy: a FENCED render publishes zero queue work; an admitted render enqueues exactly once", async () => {
  freshContext();
  const renderRoute = await loadRenderRoute();
  ctx.d1.db.prepare(`UPDATE receipt_records SET needs_render=1, source_type='email_body' WHERE id='r1'`).run();
  const req = () =>
    new Request("http://localhost/api/receipts/r1/render", {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-receipts-processor-key": "test-processor-key" },
      body: new Uint8Array([7, 7]),
    });

  const db = ctx.d1.asD1();
  const dbMod = await import("@/lib/receipts/db");
  const exportId = await dbMod.createExport("2026-01", "op", db);
  await (await loadLock()).acquireSealClaim(db, { exportId, finalize: false });
  const fenced = await renderRoute.POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(fenced.status, 409);
  assert.equal(queueSends.length, 0, "zero queue work for a rejected render publication");

  await (await loadLock()).releaseSealClaim(db, exportId, (ctx.d1.db.prepare(`SELECT sealing_token FROM receipt_exports WHERE id=?`).get(exportId) as never as { sealing_token: string }).sealing_token);
  const ok = await renderRoute.POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(ok.status, 200);
  assert.equal(queueSends.length, 1, "admitted render enqueued exactly once");
  const okBody = (await ok.json()) as { enqueued: boolean };
  assert.equal(okBody.enqueued, true);
});


// ─── Round 3: F1 identity bypass at the route boundary ───────────────────────

guardedTest("R3-F1 renaming the in-build receipt mid-flight is fenced; the seal cannot publish an item for an absent id", async () => {
  freshContext();
  const [reached, release] = ctx.archive.armPauseAt(3);
  const inFlight = runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  await reached;
  assert.throws(
    () => ctx.d1.db.prepare(`UPDATE receipt_records SET id='renamed' WHERE id='r1'`).run(),
    /DZ_SEAL_CLAIM_ACTIVE/,
    "identity mutation is fenced under the live claim",
  );
  release();
  const res = await inFlight;
  assert.equal(res.status, 200);
  // The published item still names the PRESENT receipt, and its promotion
  // audit names the same id (no false audit for an absent row).
  const items = ctx.d1.db.prepare(`SELECT item_id FROM receipt_export_items WHERE item_type='receipt'`).all() as never as { item_id: string }[];
  assert.deepEqual(items.map((i) => i.item_id), ["r1"]);
  const audits = (ctx.d1.db.prepare(`SELECT object_id FROM receipt_audit_log WHERE action='receipt.exported'`).all() as never as { object_id: string }[]).map((a) => a.object_id);
  assert.deepEqual(audits, ["r1"]);
});

guardedTest("R3-F1 renaming a receipt AFTER sealing is fenced; the finalized item keeps a live target", async () => {
  freshContext();
  const sealed = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  assert.equal(sealed.status, 200);
  assert.throws(
    () => ctx.d1.db.prepare(`UPDATE receipt_records SET id='renamed' WHERE id='r1'`).run(),
    /DZ_SEAL_MONTH_LOCKED/,
    "identity mutation is fenced after publication",
  );
});

// ─── Round 3: F7 canonical file-map ordering + created_at fence ──────────────

guardedTest("R3-F7 the shared manifest map preserves canonical original-first/created-at order (reverse insertion)", async () => {
  freshContext();
  const { loadReceiptFilesMap } = await import("@/lib/receipts/files");
  // A SECOND original for r1, inserted later but stamped EARLIER — the map
  // must pick the earlier created_at first, exactly like listFilesForObject.
  ctx.d1.db.prepare(
    `INSERT INTO receipt_files
       (id,object_type,object_id,role,r2_bucket,r2_key,original_filename,content_type,
        file_size_bytes,sha256_hash,uploaded_by,uploaded_at,is_original,created_at,updated_at)
     VALUES ('f0','receipt','r1','original','receipts','receipts/2026/01/r1/orig-old.jpg','orig-old.jpg',
        'image/jpeg',10,'74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0','op','2026-01-02T00:00:00Z',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
  ).run();
  ctx.receipts.objects.set("receipts/2026/01/r1/orig-old.jpg", new Uint8Array([1, 2, 3, 4, 5]));
  const map = await loadReceiptFilesMap(ctx.d1.asD1(), ["r1"]);
  const files = map.get("r1")!;
  assert.equal(files.length, 2);
  assert.equal(files[0]!.r2_key, "receipts/2026/01/r1/orig-old.jpg", "earlier created_at original comes first");
  // Proof selection from the map uses the same first-match rule.
  const chosen = files.find((f) => f.role === "proof_copy") ?? files.find((f) => f.role === "original");
  assert.equal(chosen!.r2_key, "receipts/2026/01/r1/orig-old.jpg");
  // And the build uses the same chosen file: the sealed proofs ZIP's evidence
  // name is derived from the map's first original (same bytes → same hash).
  const res = await runRoute({ month: "2026-01", finalize: false });
  assert.equal(res.status, 200);
  const manifest = ctx.archive.objects.get(
    (ctx.d1.db.prepare(`SELECT manifest_r2_key FROM receipt_exports WHERE export_month='2026-01'`).get() as never as { manifest_r2_key: string }).manifest_r2_key,
  );
  const manifestText = new TextDecoder().decode(manifest!);
  assert.ok(manifestText.includes("receipts/2026/01/r1/orig-old.jpg"), "the map's first original is the manifest's selected proof");
});

guardedTest("R3-F7 created_at on receipt_files is fenced under an active claim (ordering input protected)", async () => {
  freshContext();
  const db = ctx.d1.asD1();
  const dbMod = await import("@/lib/receipts/db");
  const exportId = await dbMod.createExport("2026-01", "op", db);
  await (await loadLock()).acquireSealClaim(db, { exportId, finalize: false });
  assert.throws(
    () => ctx.d1.db.prepare(`UPDATE receipt_files SET created_at='2025-01-01T00:00:00Z' WHERE id='f1'`).run(),
    /DZ_SEAL_CLAIM_ACTIVE/,
  );
});

// ─── Round 3: B9 extraction retryable classification at the actual route ─────

guardedTest("R3-B9 /extract answers a temporary claim conflict 503 + Retry-After (consumer 4xx-terminal safety)", async () => {
  freshContext();
  const extractRoute = await import("@/app/api/receipts/[id]/extract/route");
  // A captured receipt the consumer would legitimately extract.
  ctx.d1.db.prepare(
    `INSERT INTO receipt_records
       (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,
        original_sha256,original_content_type,original_size_bytes,created_at,updated_at,
        export_statement_month,extraction_state)
     VALUES ('r9','2026-01-05T00:00:00Z','op','CASH',NULL,'captured','k9','sh9','image/jpeg',9,'t','t','2026-01','captured')`,
  ).run();
  const db = ctx.d1.asD1();
  const dbMod = await import("@/lib/receipts/db");
  const exportId = await dbMod.createExport("2026-01", "op", db);
  await (await loadLock()).acquireSealClaim(db, { exportId, finalize: false });
  const res = await extractRoute.POST(
    new Request("http://localhost/api/receipts/r9/extract", {
      method: "POST",
      headers: { "content-type": "application/json", "x-receipts-processor-key": "test-processor-key" },
      body: JSON.stringify({ rawText: "テスト商店 2026-01-12 1,000円", model: "mlx_local:test" }),
    }),
    { params: Promise.resolve({ id: "r9" }) },
  );
  assert.equal(res.status, 503, "temporary claim conflicts are retryable, never 409 (4xx would ack+drop)");
  assert.equal(res.headers.get("Retry-After"), "60");
  const body = (await res.json()) as { retryable: boolean };
  assert.equal(body.retryable, true);
  // Nothing was applied by the rejected extraction.
  const row = ctx.d1.db.prepare(`SELECT merchant, amount_minor FROM receipt_records WHERE id='r9'`).get() as never as { merchant: string | null; amount_minor: number | null };
  assert.equal(row.merchant, null);
  assert.equal(row.amount_minor, null);
});

// ─── Round 3: expired-A / resumed-after-B publication race ────────────────────

guardedTest("R5-A7 natural D1-time lease expiry: route A parked before AND after each of the 8 cash puts, receipt inputs changed, actual route B finalizes, A resumes 409 — winner/legacy bytes and audits unchanged", async () => {
  // Round-4 review non-blocking 1: the prior version of this test released A's
  // claim explicitly (a substitution for expiry). This orchestration is the
  // reviewer's: ONLY route A's first acquisition gets a short lease (+1s,
  // patched into the acquisition SQL); every predicate and the publication CAS
  // remain the real SQL. A parks before OR after put #ordinal, the lease lapses
  // by real clock time (1.1s), the receipt inputs change, actual route B
  // acquires over the expired claim and finalizes, then A resumes and must lose.
  for (const after of [false, true]) {
    for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
      freshContext();
      const label = `${after ? "after" : "before"} put ${ordinal}`;
      const prepare = ctx.d1.prepare.bind(ctx.d1);
      let firstAcquire = true;
      ctx.d1.prepare = ((sql: string) => {
        if (firstAcquire && sql.includes("SET sealing_token = ?")) {
          firstAcquire = false;
          sql = sql.replace(/\+ 600/, "+ 1");
        }
        return prepare(sql);
      }) as typeof ctx.d1.prepare;

      const legacyKey = "exports/2025-12/legacy-summary.csv";
      const legacyBytes = new TextEncoder().encode("legacy sealed bytes");
      ctx.archive.objects.set(legacyKey, legacyBytes);

      const put = ctx.archive.put.bind(ctx.archive);
      let aPuts = 0;
      let reach!: () => void;
      let resume!: () => void;
      const reached = new Promise<void>((r) => (reach = r));
      const parked = new Promise<void>((r) => (resume = r));
      let pausing = true;
      ctx.archive.put = (async (key: string, data: ArrayBuffer | Uint8Array, opts?: { onlyIf?: { etagDoesNotMatch?: string } }) => {
        aPuts += 1;
        const hold = pausing && aPuts === ordinal;
        if (hold && !after) {
          reach();
          await parked;
        }
        const result = await put(key, data, opts);
        if (hold && after) {
          reach();
          await parked;
        }
        return result;
      }) as typeof ctx.archive.put;

      const a = runRoute({ month: "2026-01", finalize: true, operatorMessage: "A older decision" });
      await reached;
      pausing = false;
      // Natural D1-time expiry: the +1s lease lapses by real clock time. No
      // explicit release anywhere in this test.
      await new Promise((r) => setTimeout(r, 1100));
      ctx.d1.db.prepare(`UPDATE receipt_records SET amount_minor=650, business_purpose='after expiry' WHERE id='r1'`).run();
      const b = await runRoute({ month: "2026-01", finalize: true, operatorMessage: "B winner" });
      assert.equal(b.status, 200, label);
      const winnerRows = ctx.d1.db.prepare("SELECT * FROM receipt_exports").all();
      const items = ctx.d1.db.prepare("SELECT * FROM receipt_export_items").all();
      const audits = ctx.d1.db.prepare("SELECT * FROM receipt_audit_log").all();
      const winnerObjects = new Map(ctx.archive.objects);
      resume();
      const aRes = await a;
      assert.equal(aRes.status, 409, label);
      assert.deepEqual(ctx.d1.db.prepare("SELECT * FROM receipt_exports").all(), winnerRows, label);
      assert.deepEqual(ctx.d1.db.prepare("SELECT * FROM receipt_export_items").all(), items, label);
      assert.deepEqual(ctx.d1.db.prepare("SELECT * FROM receipt_audit_log").all(), audits, label);
      for (const [key, bytes] of winnerObjects) {
        assert.deepEqual(ctx.archive.objects.get(key), bytes, `${label}: ${key}`);
      }
      assert.deepEqual(ctx.archive.objects.get(legacyKey), legacyBytes, label);
    }
  }
});

guardedTest("R3-F2 a delivery that reached the recipient AFTER planning refuses the whole deletion", async () => {
  freshContext();
  const { executeExportDeletion } = await import("@/lib/receipts/export-deletion");
  const db = ctx.d1.asD1();
  const build = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  const { exportId } = (await build.json()) as { exportId: string };
  const row = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(exportId) as never as Record<string, unknown>;
  // The plan was legal (no deliveries); a 'sent' delivery lands before execution.
  ctx.d1.db.prepare(
    `INSERT INTO export_deliveries (id,export_id,attempt_id,idempotency_key,state,to_address,subject,body,zip_filename,zip_sha256,zip_bytes,created_at)
     VALUES ('d1',?,'a1','k1','sent','x@y','s','b','z.zip','zh',1,'t')`,
  ).run(exportId);
  await assert.rejects(
    executeExportDeletion(db, {
      exportId,
      month: "2026-01",
      plannedStatus: "finalized",
      actor: "delete-sealed-export.ts",
      nowIso: new Date().toISOString(),
      auditId: "audit-f2",
      assertId: "assert-f2",
      auditValueJson: "{}",
      plannedIdentity: {
        bundleBuildId: (row.bundle_build_id as string | null) ?? null,
        archiveKey: (row.archive_r2_key as string | null) ?? null,
        manifestKey: (row.manifest_r2_key as string | null) ?? null,
        proofsKey: (row.proofs_r2_key as string | null) ?? null,
      },
    }),
    (err: unknown) => /constraint|NOT NULL|DZ_SEAL/i.test((err as Error).message),
    "admission fails in-transaction (marker 0 rows → assertion)",
  );
  // Everything intact: export, delivery history, items; no stray audits.
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports WHERE id=?`).get(exportId) as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM export_deliveries WHERE export_id=?`).get(exportId) as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items WHERE export_id=?`).get(exportId) as never as { n: number }).n, 1);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_audit_log WHERE object_id=? AND action LIKE 'export.deleted%'`).get(exportId) as never as { n: number }).n, 0);
});

guardedTest("R4-F2 a same-STATUS draft→draft rebuild with a different published build refuses the planned deletion (build identity, not status, is the guard)", async () => {
  freshContext();
  const { executeExportDeletion } = await import("@/lib/receipts/export-deletion");
  const db = ctx.d1.asD1();
  // Build 1 (draft, unbuilt→built) then Build 2 — BOTH leave the row a DRAFT,
  // so plannedStatus matches; only bundle_build_id/keys differ.
  const build1 = await runRoute({ month: "2026-01", finalize: false });
  const { exportId } = (await build1.json()) as { exportId: string };
  const row1 = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(exportId) as never as Record<string, unknown>;
  const build2 = await runRoute({ month: "2026-01", finalize: false });
  assert.equal(build2.status, 200);
  const statusNow = (ctx.d1.db.prepare(`SELECT status FROM receipt_exports WHERE id=?`).get(exportId) as never as { status: string }).status;
  assert.equal(statusNow, "draft", "row stayed a draft — the refusal below can only come from the build/key identity");
  assert.notEqual(row1.bundle_build_id, (ctx.d1.db.prepare(`SELECT bundle_build_id FROM receipt_exports WHERE id=?`).get(exportId) as never as { bundle_build_id: string }).bundle_build_id, "the rebuild actually changed the build identity");
  await assert.rejects(
    executeExportDeletion(db, {
      exportId,
      month: "2026-01",
      plannedStatus: "draft",
      actor: "delete-sealed-export.ts",
      nowIso: new Date().toISOString(),
      auditId: "audit-f2b",
      assertId: "assert-f2b",
      auditValueJson: "{}",
      plannedIdentity: {
        bundleBuildId: (row1.bundle_build_id as string | null) ?? null,
        archiveKey: (row1.archive_r2_key as string | null) ?? null,
        manifestKey: (row1.manifest_r2_key as string | null) ?? null,
        proofsKey: (row1.proofs_r2_key as string | null) ?? null,
      },
    }),
    (err: unknown) => /constraint|NOT NULL|DZ_SEAL/i.test((err as Error).message),
    "stale planned build identity refuses admission at the SAME status",
  );
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports WHERE id=?`).get(exportId) as never as { n: number }).n, 1, "the rebuilt export survives");
});

guardedTest("R3-F3 zero-row admission (draft, wrong planned month) rolls back EVERYTHING — no partial deletion, no stray audit", async () => {
  freshContext();
  const { executeExportDeletion } = await import("@/lib/receipts/export-deletion");
  const db = ctx.d1.asD1();
  const build = await runRoute({ month: "2026-01", finalize: false });
  const { exportId } = (await build.json()) as { exportId: string };
  const before = {
    exports: (ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports`).get() as never as { n: number }).n,
    items: (ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items`).get() as never as { n: number }).n,
    audits: (ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_audit_log`).get() as never as { n: number }).n,
  };
  const draftRow = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(exportId) as never as Record<string, unknown>;
  await assert.rejects(
    executeExportDeletion(db, {
      exportId,
      month: "2099-12", // never matches → marker inserts 0 rows → assertion
      plannedStatus: "draft",
      actor: "x",
      nowIso: "t",
      auditId: "audit-f3",
      assertId: "assert-f3",
      auditValueJson: "{}",
      plannedIdentity: {
        bundleBuildId: (draftRow.bundle_build_id as string | null) ?? null,
        archiveKey: (draftRow.archive_r2_key as string | null) ?? null,
        manifestKey: (draftRow.manifest_r2_key as string | null) ?? null,
        proofsKey: (draftRow.proofs_r2_key as string | null) ?? null,
      },
    }),
    (err: unknown) => /constraint|NOT NULL/i.test((err as Error).message),
  );
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports`).get() as never as { n: number }).n, before.exports, "draft NOT deleted");
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items`).get() as never as { n: number }).n, before.items, "items NOT deleted");
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_audit_log`).get() as never as { n: number }).n, before.audits, "no marker, no admission row");
});

guardedTest("R3-F3 an injected failure at the deliveries/parent tail rolls the marker and admission back with everything else", async () => {
  freshContext();
  const { executeExportDeletion } = await import("@/lib/receipts/export-deletion");
  const db = ctx.d1.asD1();
  const build = await runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  const { exportId } = (await build.json()) as { exportId: string };
  const row = ctx.d1.db.prepare(`SELECT * FROM receipt_exports WHERE id=?`).get(exportId) as never as Record<string, unknown>;
  for (const match of [/DELETE FROM export_deliveries/, /DELETE FROM receipt_exports WHERE id/]) {
    ctx.d1.injectFailure = (sql: string) => (match.test(sql) ? new Error("injected deletion-tail failure") : null);
    await assert.rejects(
      executeExportDeletion(db, {
        exportId,
        month: "2026-01",
        plannedStatus: "finalized",
        actor: "x",
        nowIso: "t",
        auditId: `audit-f3b-${match.source}`,
        assertId: `assert-f3b-${match.source}`,
        auditValueJson: "{}",
        plannedIdentity: {
          bundleBuildId: (row.bundle_build_id as string | null) ?? null,
          archiveKey: (row.archive_r2_key as string | null) ?? null,
          manifestKey: (row.manifest_r2_key as string | null) ?? null,
          proofsKey: (row.proofs_r2_key as string | null) ?? null,
        },
      }),
      /injected deletion-tail failure/,
    );
    ctx.d1.injectFailure = null;
    assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_exports WHERE id=?`).get(exportId) as never as { n: number }).n, 1, `export intact for ${match}`);
    assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items WHERE export_id=?`).get(exportId) as never as { n: number }).n, 1, `items intact for ${match}`);
    assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_audit_log WHERE object_id=? AND action LIKE 'export.deleted%'`).get(exportId) as never as { n: number }).n, 0, `no audit rows survive for ${match}`);
  }
});

// ─── Round 4: R1 exported_month-only INSERT at the actual route ──────────────

guardedTest("R4-R1 an exported_month-only INSERT mid-build is fenced; the finalize cannot seal a silently-widened gate", async () => {
  freshContext();
  const [reached, release] = ctx.archive.armPauseAt(3);
  const inFlight = runRoute({ month: "2026-01", finalize: true, operatorMessage: null });
  await reached; // build holds the claim, gate already validated

  // The reviewer's probe: a CASH receipt dated FEBRUARY whose only relationship
  // to January is exported_month — no statement month, incomplete fields.
  assert.throws(
    () =>
      ctx.d1.db
        .prepare(
          `INSERT INTO receipt_records
             (id,captured_at,captured_by,payment_path,transaction_date,status,original_r2_key,
              original_sha256,original_content_type,original_size_bytes,created_at,updated_at,exported_month)
           VALUES ('rx','2026-02-01T00:00:00Z','op','CASH','2026-02-01','captured','kx','sh','image/jpeg',1,'t','t','2026-01')`,
        )
        .run(),
    /DZ_SEAL_CLAIM_ACTIVE/,
    "exported_month alone is gate scope during a claim",
  );

  release();
  const res = await inFlight;
  assert.equal(res.status, 200);
  // The sealed month's compliance population is exactly the fixture's — the
  // would-be blocker receipt never entered it.
  const pop = ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_records WHERE exported_month='2026-01' AND id='rx'`).get() as never as { n: number };
  assert.equal(pop.n, 0);
});
