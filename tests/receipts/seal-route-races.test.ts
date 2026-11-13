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
import { acquireSealClaim, releaseSealClaim } from "@/lib/receipts/month-lock";

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
  private chain: Promise<unknown> = Promise.resolve();

  prepare(sql: string) {
    // The bound form carries the args; the bare form (no .bind) runs with none
    // — some helpers call prepare(sql).all() directly.
    const make = (args: unknown[]) => {
      const spec = { sql, args } as { sql: string; args: unknown[] };
      return {
        first: async <T>(): Promise<T | null> => {
          await this.onBeforeStatement?.(sql);
          return (this.db.prepare(sql).get(...args) ?? null) as T | null;
        },
        all: async <T>(): Promise<{ results: T[] }> => {
          await this.onBeforeStatement?.(sql);
          return { results: this.db.prepare(sql).all(...args) as T[] };
        },
        run: async (): Promise<{ success: true; meta: { changes: number } }> => {
          await this.onBeforeStatement?.(sql);
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

/** Minimal R2 bucket: conditional no-overwrite puts, byte-exact gets. */
class FakeBucket {
  objects = new Map<string, Uint8Array>();
  putCallCount = 0;
  failOnPut: number | null = null; // 1-based put ordinal that throws

  async put(key: string, data: ArrayBuffer | Uint8Array, opts?: { onlyIf?: { etagDoesNotMatch?: string } }) {
    this.putCallCount += 1;
    if (this.failOnPut === this.putCallCount) throw new Error("injected: R2 put failed");
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (opts?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) {
      return null;
    }
    this.objects.set(key, bytes);
    return { etag: "e" };
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
      getReceiptsQueue: () => null,
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
  const expiredId = await dbMod.createExport("2026-01", "op", db);
  await acquireSealClaim(db, { exportId: expiredId, finalize: false, leaseSeconds: -5 });
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
  await acquireSealClaim(db, { exportId, finalize: false });
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
  await acquireSealClaim(db, { exportId, finalize: false });
  const fenced = await (await loadRenderRoute()).POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(fenced.status, 409);
  let row = ctx.d1.db.prepare(`SELECT needs_render, extraction_r2_key FROM receipt_records WHERE id='r1'`).get() as never as Record<string, unknown>;
  assert.equal(row.needs_render, 1, "fence left the render-pending state intact");
  assert.equal(row.extraction_r2_key, null);
  assert.equal((ctx.d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_files WHERE object_id='r1' AND role='processed'`).get() as { n: number }).n, 0, "no manifest row for a rejected render");

  // Release (simulate lease expiry via a fresh acquirable state) and admit.
  await releaseSealClaim(db, exportId, (ctx.d1.db.prepare(`SELECT sealing_token FROM receipt_exports WHERE id=?`).get(exportId) as never as { sealing_token: string }).sealing_token);
  const ok = await (await loadRenderRoute()).POST(req(), { params: Promise.resolve({ id: "r1" }) });
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { r2Key: string; enqueued: boolean };
  assert.match(okBody.r2Key, /^receipts\/r1\/rendered-[0-9a-f-]+\.(pdf|png)$/, "versioned immutable key");
  row = ctx.d1.db.prepare(`SELECT needs_render, extraction_r2_key FROM receipt_records WHERE id='r1'`).get() as never as Record<string, unknown>;
  assert.equal(row.needs_render, 0, "admitted render cleared needs_render");
  assert.equal(row.extraction_r2_key, okBody.r2Key);
  assert.equal(okBody.enqueued, false, "no queue binding in tests — best-effort enqueue degrades");
});
