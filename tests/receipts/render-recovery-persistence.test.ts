// Real-engine persistence tests for the render-recovery core (round-2 review
// B1–B4 + round-3 R1–R3/N1): recordRenderFailure / retryRender run against a
// REAL SQLite database (node:sqlite DatabaseSync) through a minimal
// D1-compatible shim, so the actual SQL — batch transactionality, json_patch
// merging, WHERE-boundary admission re-checks, affected-rows inspection,
// seal guards — is executed, not mocked.
//
// Scope (accurate, per review N2): these exercise the CORE functions the
// routes call. The route shells add only auth + body parsing + result
// mapping; their HTTP boundaries are covered by local preview probes and
// the parser matrix — NOT by this file.
//
// Race windows are simulated at the SQL boundary: `onBeforeRun` (sync) and
// `onBeforeRunAsync` (awaitable) fire immediately before each mutating
// statement executes — inside batch statements too — letting a test mutate
// the row or pause one request BETWEEN a function's read and its write, the
// exact interleavings the review reproduced.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRenderFailedBody,
  recordRenderFailure,
  retryRender,
} from "@/lib/receipts/render-recovery";
import { isMonthLockedForEdits } from "@/lib/receipts/month-lock";

// node:sqlite typings are not in this repo's @types/node yet (experimental
// API). Require it (typed by @types/node) and declare the minimal surface.
interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
type DatabaseSyncCtor = new (path: string) => SqliteDatabase;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- node:sqlite has no typings in this @types/node yet; see the interfaces above
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };

// ─── Minimal D1 shim over real SQLite ───────────────────────────────────────

const SCHEMA = `
CREATE TABLE receipt_records (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'captured',
  captured_at TEXT, captured_by TEXT, source TEXT,
  payment_path TEXT NOT NULL DEFAULT 'UNKNOWN',
  transaction_date TEXT,
  merchant TEXT, amount_minor INTEGER, currency TEXT,
  original_r2_key TEXT, original_filename TEXT,
  extraction_state TEXT, extraction_enqueued_at TEXT,
  extraction_processed_at TEXT, extraction_json TEXT,
  needs_render INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  deleted_at TEXT
);
CREATE TABLE receipt_exports (id TEXT PRIMARY KEY, export_month TEXT, status TEXT);
CREATE TABLE amex_statement_lines (id TEXT PRIMARY KEY, statement_month TEXT, matched_receipt_id TEXT);
CREATE TABLE amex_reconciliations (id TEXT PRIMARY KEY, statement_month TEXT, status TEXT);
CREATE TABLE receipt_audit_log (
  id TEXT PRIMARY KEY, actor TEXT, action TEXT, object_type TEXT, object_id TEXT,
  old_value_json TEXT, new_value_json TEXT, created_at TEXT
);
`;

class SqliteD1 {
  /** Real SQLite engine; exposed for fixture setup and race mutations. */
  readonly db: SqliteDatabase;
  /** Fires immediately before a mutating statement executes (race hook). */
  onBeforeRun: ((sql: string) => void) | null = null;
  /** Awaitable race hook — holds a statement so a concurrent request runs. */
  onBeforeRunAsync: ((sql: string) => Promise<void>) | null = null;

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(SCHEMA);
  }

  /** Raw escape hatch for fixture setup / race mutations. */
  exec(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  private async maybeHook(sql: string): Promise<void> {
    if (!/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) return;
    if (this.onBeforeRun) this.onBeforeRun(sql);
    if (this.onBeforeRunAsync) await this.onBeforeRunAsync(sql);
  }

  prepare(sql: string) {
    const make = (args: unknown[]) => ({
      first: async <T>(): Promise<T | null> => {
        const row = this.db.prepare(sql).get(...args);
        return (row ?? null) as T | null;
      },
      all: async <T>(): Promise<{ results: T[] }> => {
        const rows = this.db.prepare(sql).all(...args);
        return { results: rows as T[] };
      },
      run: async (): Promise<{ success: true; meta: { changes: number } }> => {
        await this.maybeHook(sql);
        const info = this.db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      /** Statement spec for batch() — D1PreparedStatement's executable form. */
      __spec: { sql, args } as { sql: string; args: unknown[] },
    });
    return { bind: (...args: unknown[]) => make(args) };
  }

  /** D1 batch semantics: statements run in ONE transaction — any failure
   *  rolls back everything already executed in the batch. Serialized on a
   *  promise chain (SQLite single-writer, like D1): a concurrent request's
   *  batch waits for the in-flight one — reads still interleave, so the
   *  two-request races in these tests are genuine. */
  private batchChain: Promise<unknown> = Promise.resolve();

  batch(
    stmts: { __spec: { sql: string; args: unknown[] } }[],
  ): Promise<{ success: true; meta: { changes: number } }[]> {
    const run = this.batchChain.then(() => this.runBatch(stmts));
    this.batchChain = run.catch(() => undefined);
    return run;
  }

  private async runBatch(
    stmts: { __spec: { sql: string; args: unknown[] } }[],
  ): Promise<{ success: true; meta: { changes: number } }[]> {
    this.db.exec("BEGIN");
    try {
      const results: { success: true; meta: { changes: number } }[] = [];
      for (const s of stmts) {
        await this.maybeHook(s.__spec.sql);
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  status: string;
  extraction_state: string | null;
  extraction_json: string | null;
  extraction_processed_at: string | null;
  needs_render: number;
  deleted_at: string | null;
  updated_at: string | null;
  transaction_date: string | null;
}

function seedRenderRow(
  d1: SqliteD1,
  overrides: Partial<Row> & { id?: string } = {},
): string {
  const id = overrides.id ?? "r-1";
  // "extraction_state" in overrides so an EXPLICIT null (legacy rows) is
  // preserved — `?? "captured"` would coerce it back to a pending state.
  const state = "extraction_state" in overrides ? overrides.extraction_state! : "captured";
  d1.exec(
    `INSERT INTO receipt_records
       (id, status, extraction_state, extraction_json, needs_render, transaction_date,
        original_filename, original_r2_key, captured_at, created_at, updated_at, currency)
     VALUES (?, ?, ?, ?, 1, NULL, 'body.html', 'k', '2026-11-01T00:00:00Z',
             '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'JPY')`,
    id,
    overrides.status ?? "captured",
    state,
    overrides.extraction_json ?? null,
  );
  if (overrides.transaction_date !== undefined && overrides.transaction_date !== null) {
    d1.exec(`UPDATE receipt_records SET transaction_date = ? WHERE id = ?`, overrides.transaction_date, id);
  }
  return id;
}

function row(d1: SqliteD1, id: string): Row {
  return d1.db
    .prepare(`SELECT * FROM receipt_records WHERE id = ?`)
    .get(id) as unknown as Row;
}

function audits(d1: SqliteD1, id: string): { action: string; created_at: string }[] {
  return d1.db
    .prepare(`SELECT action, created_at FROM receipt_audit_log WHERE object_id = ? ORDER BY created_at, rowid`)
    .all(id) as unknown as { action: string; created_at: string }[];
}

const PREEXISTING_JSON = JSON.stringify({
  merchant: "已有的商人",
  amountMinor: 4200,
  operatorNote: "keep me",
  partialExtraction: true,
});

// ─── B1: preserve extraction data + first terminal marker ───────────────────

test("B1 recordRenderFailure merges into preexisting extraction_json, preserving non-failure data", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_json: PREEXISTING_JSON });
  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "WeasyPrint produced an empty PDF", actor: "mlx-consumer@mac", now: "2026-11-11T10:00:00Z" });
  assert.equal(res.kind, "recorded");
  const stored = JSON.parse(row(d1, id).extraction_json!);
  assert.equal(stored.merchant, "已有的商人");
  assert.equal(stored.amountMinor, 4200);
  assert.equal(stored.operatorNote, "keep me");
  assert.equal(stored.failed, true);
  assert.equal(stored.stage, "render");
  assert.equal(stored.reason, "WeasyPrint produced an empty PDF");
  assert.equal(stored.failedAt, "2026-11-11T10:00:00Z");
  assert.equal(row(d1, id).extraction_state, "failed");
  assert.equal(row(d1, id).extraction_processed_at, "2026-11-11T10:00:00Z");
});

test("B1 repeated report with a DIFFERENT reason is read-only idempotent: first marker wins, no mutation, no audit", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_json: PREEXISTING_JSON });
  await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "first reason", actor: "mlx", now: "2026-11-11T10:00:00Z" });
  const afterFirst = row(d1, id);
  const auditsFirst = audits(d1, id);

  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "second, different reason", actor: "mlx", now: "2026-11-11T11:00:00Z" });
  assert.equal(res.kind, "already_terminal");
  assert.equal(res.reason, "first reason");
  assert.equal(res.failedAt, "2026-11-11T10:00:00Z");

  const afterSecond = row(d1, id);
  assert.equal(afterSecond.extraction_json, afterFirst.extraction_json); // byte-identical
  assert.equal(afterSecond.updated_at, afterFirst.updated_at); // not even touched
  assert.equal(afterSecond.extraction_processed_at, afterFirst.extraction_processed_at);
  assert.deepEqual(audits(d1, id), auditsFirst); // no repeated audit
});

test("R1 SQL merge edge cases: null / array / malformed current JSON → fresh failure payload only", async () => {
  const d1 = new SqliteD1();
  const cases: Array<[string, string | null]> = [
    ["null-json", null],
    ["array-json", "[1,2]"],
    ["malformed-json", "{not json"],
  ];
  for (const [id, json] of cases) {
    seedRenderRow(d1, { id, extraction_json: json });
    const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "r", actor: "mlx", now: "2026-11-11T10:00:00Z" });
    assert.equal(res.kind, "recorded", id);
    assert.deepEqual(JSON.parse(row(d1, id).extraction_json!), {
      failed: true,
      stage: "render",
      reason: "r",
      failedAt: "2026-11-11T10:00:00Z",
    });
  }
});

// ─── B2: atomic commit + rollback ────────────────────────────────────────────

test("B2 pre-execution write failure leaves the row untouched (no partial commit)", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_json: PREEXISTING_JSON });
  // Fail the terminal UPDATE BEFORE it executes (models D1 rejecting the
  // statement). An error DURING statement execution / later in the batch is
  // covered by the R3 rollback tests below.
  d1.onBeforeRun = (sql) => {
    if (sql.includes("SET extraction_state = 'failed'")) {
      throw new Error("D1_ERROR: simulated write failure");
    }
  };
  await assert.rejects(
    recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "r", actor: "mlx" }),
    /simulated write failure/,
  );
  d1.onBeforeRun = null;
  // Atomic: NOT failed-without-reason — the row is exactly as it started.
  const r = row(d1, id);
  assert.equal(r.extraction_state, "captured");
  assert.equal(r.extraction_json, PREEXISTING_JSON);
  assert.equal(r.extraction_processed_at, null);
  assert.equal(audits(d1, id).length, 0);
});

test("B2 read-then-act race: review advances the row before the write → honest conflict, no partial commit", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_json: PREEXISTING_JSON });
  d1.onBeforeRun = (sql) => {
    if (sql.includes("SET extraction_state = 'failed'")) {
      // A human review lands between the read and the conditional write.
      d1.exec(`UPDATE receipt_records SET status = 'reviewed' WHERE id = ?`, id);
    }
  };
  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "r", actor: "mlx" });
  d1.onBeforeRun = null;
  assert.equal(res.kind, "conflict");
  assert.match((res as { error: string }).error, /changed before/);
  const r = row(d1, id);
  assert.equal(r.extraction_state, "captured"); // terminal state did NOT commit
  assert.equal(r.extraction_json, PREEXISTING_JSON); // reason did not commit either
});

// ─── B3: retry admission at the write boundary ──────────────────────────────

test("B3 retry happy path: clears marker atomically, resets processed_at, audits once", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_state: "failed", extraction_json: JSON.stringify({ failed: true, stage: "render", reason: "x", failedAt: "t" }), extraction_processed_at: "t" });
  const res = await retryRender({ db: d1.asD1(), receiptId: id, actor: "op@dazbeez.com" });
  assert.equal(res.kind, "retrying");
  const r = row(d1, id);
  assert.equal(r.extraction_state, "captured");
  assert.equal(r.extraction_processed_at, null);
  assert.equal(r.needs_render, 1); // still awaiting render
  assert.equal(audits(d1, id).filter((a) => a.action === "receipt.render_retry").length, 1);
});

test("B3 delete race: deleted_at set before the write → row untouched + not_found, no success audit", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_state: "failed", extraction_json: JSON.stringify({ failed: true }) });
  d1.onBeforeRun = (sql) => {
    if (sql.includes("SET extraction_state = 'captured'")) {
      d1.exec(`UPDATE receipt_records SET deleted_at = '2026-11-11T00:00:00Z' WHERE id = ?`, id);
    }
  };
  const res = await retryRender({ db: d1.asD1(), receiptId: id, actor: "op" });
  d1.onBeforeRun = null;
  assert.equal(res.kind, "not_found");
  const r = row(d1, id);
  assert.equal(r.extraction_state, "failed"); // NOT resurrected
  assert.ok(r.deleted_at); // still deleted — we did not touch it
  assert.equal(audits(d1, id).length, 0); // no false success audit
});

test("B3 review race: status advances before the write → honest conflict naming the state, no success audit", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_state: "failed", extraction_json: JSON.stringify({ failed: true }) });
  d1.onBeforeRun = (sql) => {
    if (sql.includes("SET extraction_state = 'captured'")) {
      d1.exec(`UPDATE receipt_records SET status = 'reviewed' WHERE id = ?`, id);
    }
  };
  const res = await retryRender({ db: d1.asD1(), receiptId: id, actor: "op" });
  d1.onBeforeRun = null;
  assert.equal(res.kind, "conflict");
  assert.match((res as { error: string }).error, /reviewed/);
  assert.equal(row(d1, id).extraction_state, "failed"); // unchanged
  assert.equal(audits(d1, id).length, 0);
});

test("B3/R3 double retry: two concurrently ADMITTED requests — one wins, the loser exercises the zero-change UPDATE branch honestly", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_state: "failed", extraction_json: JSON.stringify({ failed: true }) });
  let retryUpdates = 0;
  d1.onBeforeRunAsync = async (sql) => {
    if (sql.includes("SET extraction_state = 'captured'")) {
      retryUpdates += 1;
      if (retryUpdates === 1) {
        // Hold request A's UPDATE one macrotask so request B runs its SELECT
        // AND its admission against the still-failed row — BOTH requests are
        // admitted; B then commits its full batch before A's UPDATE executes.
        await new Promise((r) => setImmediate(r));
      }
    }
  };
  const [ra, rb] = await Promise.all([
    retryRender({ db: d1.asD1(), receiptId: id, actor: "op", now: "2026-11-11T10:00:00.000Z" }),
    retryRender({ db: d1.asD1(), receiptId: id, actor: "op", now: "2026-11-11T10:00:00.001Z" }),
  ]);
  d1.onBeforeRunAsync = null;
  // Exactly one retry admitted; the other hit the zero-change UPDATE and
  // reported the actual (now captured) state — never a false success.
  const kinds = [ra.kind, rb.kind].sort();
  assert.deepEqual(kinds, ["conflict", "retrying"]);
  const loser = ra.kind === "conflict" ? ra : rb;
  assert.match((loser as { error: string }).error, /changed before/);
  assert.match((loser as { error: string }).error, /extraction_state='captured'/);
  assert.equal(row(d1, id).extraction_state, "captured");
  // The guarded audit INSERT fired exactly once (winner only).
  assert.equal(audits(d1, id).filter((a) => a.action === "receipt.render_retry").length, 1);
});

test("B3 sealed-month fixture (export-finalized, no draft): retry refused at the WRITE boundary, row stays terminal", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, {
    status: "needs_review",
    extraction_state: "failed",
    extraction_json: JSON.stringify({ failed: true, stage: "render", reason: "x" }),
    transaction_date: "2026-05-10", // operator-set date inside the sealed month
  });
  d1.exec(`INSERT INTO receipt_exports (id, export_month, status) VALUES ('e1', '2026-05', 'finalized')`);
  const res = await retryRender({ db: d1.asD1(), receiptId: id, actor: "op" });
  assert.equal(res.kind, "conflict");
  assert.match((res as { error: string }).error, /sealed month \(2026-05\)/);
  assert.equal(row(d1, id).extraction_state, "failed");
  assert.equal(audits(d1, id).length, 0);
});

test("B3 ADR-0012 draft carve-out: open draft releases the seal and the retry proceeds", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, {
    status: "needs_review",
    extraction_state: "failed",
    extraction_json: JSON.stringify({ failed: true }),
    transaction_date: "2026-05-10",
  });
  d1.exec(`INSERT INTO receipt_exports (id, export_month, status) VALUES ('e1', '2026-05', 'finalized')`);
  d1.exec(`INSERT INTO receipt_exports (id, export_month, status) VALUES ('e2', '2026-05', 'draft')`);
  const res = await retryRender({ db: d1.asD1(), receiptId: id, actor: "op" });
  assert.equal(res.kind, "retrying");
  assert.equal(row(d1, id).extraction_state, "captured");
});

test("B3 reconciliation-sealed fixture: AMEX-matched receipt in an edit-locked finalized reconciliation is refused", async () => {
  const d1 = new SqliteD1();
  // Undated row — only the AMEX-match lock can apply.
  const id = seedRenderRow(d1, {
    status: "needs_review",
    extraction_state: "failed",
    extraction_json: JSON.stringify({ failed: true }),
  });
  d1.exec(`INSERT INTO amex_reconciliations (id, statement_month, status) VALUES ('ar1', '2026-05', 'finalized')`);
  d1.exec(`INSERT INTO receipt_exports (id, export_month, status) VALUES ('e1', '2026-05', 'finalized')`);
  d1.exec(`INSERT INTO amex_statement_lines (id, statement_month, matched_receipt_id) VALUES ('l1', '2026-05', ?)`, id);
  const res = await retryRender({ db: d1.asD1(), receiptId: id, actor: "op" });
  assert.equal(res.kind, "conflict");
  assert.match((res as { error: string }).error, /sealed month/);
  assert.equal(row(d1, id).extraction_state, "failed");
});

test("B3 executable equivalence: the embedded seal guard agrees with canonical isMonthLockedForEdits on the same fixture", async () => {
  const d1 = new SqliteD1();
  const mk = (month: string, status: string) =>
    d1.exec(`INSERT INTO receipt_exports (id, export_month, status) VALUES (?, ?, ?)`, `e-${month}-${status}`, month, status);
  // finalized only → locked; draft release → unlocked; nothing → unlocked.
  mk("2026-06", "finalized");
  mk("2026-07", "finalized");
  mk("2026-07", "draft");
  const canonical = {
    "2026-06": await isMonthLockedForEdits(d1.asD1() as never, "2026-06"),
    "2026-07": await isMonthLockedForEdits(d1.asD1() as never, "2026-07"),
    "2026-08": await isMonthLockedForEdits(d1.asD1() as never, "2026-08"),
  };
  assert.deepEqual(canonical, { "2026-06": true, "2026-07": false, "2026-08": false });
  // And the retry write admits the draft-carve-out month (2026-07) but not the
  // locked one (2026-06) — same fixture, same engine.
  for (const month of ["2026-06", "2026-07"]) {
    const id = `r-${month}`;
    seedRenderRow(d1, {
      id,
      status: "needs_review",
      extraction_state: "failed",
      extraction_json: JSON.stringify({ failed: true }),
      transaction_date: `${month}-10`,
    });
    const res = await retryRender({ db: d1.asD1(), receiptId: id, actor: "op" });
    assert.equal(res.kind, month === "2026-06" ? "conflict" : "retrying", month);
  }
});

test("B3 recordRenderFailure rejects deleted rows as not_found without any write", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, {});
  d1.exec(`UPDATE receipt_records SET deleted_at = '2026-11-11T00:00:00Z' WHERE id = ?`, id);
  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "r", actor: "mlx" });
  assert.equal(res.kind, "not_found");
  assert.equal(row(d1, id).extraction_state, "captured");
  assert.equal(audits(d1, id).length, 0);
});

// ─── R1: concurrent extraction_json edit survives the terminal write ────────

test("R1 concurrent JSON edit between the read and the UPDATE is PRESERVED (json_patch merges against the current column)", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_json: PREEXISTING_JSON });
  d1.onBeforeRun = (sql) => {
    if (sql.includes("SET extraction_state = 'failed'")) {
      // An operator/extraction edit lands between recordRenderFailure's read
      // and its write — same lifecycle fields, different JSON content (the
      // exact lost-update interleaving from the review).
      d1.exec(
        `UPDATE receipt_records SET extraction_json = ?,
           updated_at = '2026-11-11T09:59:59Z' WHERE id = ?`,
        JSON.stringify({ operatorNote: "newly saved", amountMinor: 999 }),
        id,
      );
    }
  };
  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "perm", actor: "mlx", now: "2026-11-11T10:00:00Z" });
  d1.onBeforeRun = null;
  assert.equal(res.kind, "recorded");
  const stored = JSON.parse(row(d1, id).extraction_json!);
  // The CONCURRENT edit's values survive — not the stale pre-read snapshot.
  assert.equal(stored.operatorNote, "newly saved");
  assert.equal(stored.amountMinor, 999);
  // Failure keys still win their namespaces.
  assert.equal(stored.failed, true);
  assert.equal(stored.stage, "render");
  assert.equal(stored.reason, "perm");
  assert.equal(stored.failedAt, "2026-11-11T10:00:00Z");
});

// ─── R2: legacy NULL extraction_state (polled by the consumer) ───────────────
//
// SCHEMA FACT (verified against db/receipts/0016_extraction_queue.sql):
// production extraction_state is `TEXT NOT NULL DEFAULT 'captured'` — NULL
// rows cannot exist in live D1, so R2's reported failure loop is NOT
// reachable in production. The consumer's poll predicate keeps a NULL arm
// anyway (documented NULL-safety), so the terminal write admits the same
// arm: poll and write predicates cannot diverge if the schema ever changes.
// This test schema (extraction_state nullable) exercises that arm.

test("R2 NULL extraction_state render row records the permanent failure (matches the consumer's poll predicate)", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_state: null, extraction_json: PREEXISTING_JSON });
  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "empty body", actor: "mlx", now: "2026-11-11T10:00:00Z" });
  assert.equal(res.kind, "recorded");
  const r = row(d1, id);
  assert.equal(r.extraction_state, "failed");
  assert.equal(r.needs_render, 1);
  const stored = JSON.parse(r.extraction_json!);
  assert.equal(stored.reason, "empty body");
  assert.equal(stored.merchant, "已有的商人"); // prior data preserved
  assert.equal(audits(d1, id).filter((a) => a.action === "receipt.render_failed").length, 1);
});

test("R2 NULL-state protections: human-advanced and deleted rows are refused without mutation", async () => {
  const d1 = new SqliteD1();
  // NULL + reviewed → conflict, and the rejection must NOT reconcile a NULL
  // state (only explicit pending states participate in that lifecycle fixup).
  const idRev = seedRenderRow(d1, { id: "rev", status: "reviewed", extraction_state: null });
  const resRev = await recordRenderFailure({ db: d1.asD1(), receiptId: idRev, reason: "r", actor: "mlx" });
  assert.equal(resRev.kind, "conflict");
  assert.equal(row(d1, idRev).extraction_state, null); // untouched
  // NULL + deleted → not_found.
  const idDel = seedRenderRow(d1, { id: "del", extraction_state: null });
  d1.exec(`UPDATE receipt_records SET deleted_at = '2026-11-11T00:00:00Z' WHERE id = 'del'`);
  assert.equal((await recordRenderFailure({ db: d1.asD1(), receiptId: idDel, reason: "r", actor: "mlx" })).kind, "not_found");
  // Non-null terminal/processed states stay rejected (regression guard).
  const idProc = seedRenderRow(d1, { id: "proc", extraction_state: "processed" });
  const resProc = await recordRenderFailure({ db: d1.asD1(), receiptId: idProc, reason: "r", actor: "mlx" });
  assert.equal(resProc.kind, "conflict");
  assert.equal(row(d1, idProc).extraction_state, "processed");
});

// ─── R3: post-UPDATE audit failure rolls the mutation back (D1 batch) ────────

test("R3 render-failed: audit-write failure AFTER the terminal UPDATE commits rolls the whole batch back", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_json: PREEXISTING_JSON });
  d1.onBeforeRun = (sql) => {
    if (sql.includes("INSERT INTO receipt_audit_log") && sql.includes("'receipt.render_failed'")) {
      throw new Error("D1_ERROR: audit write failed after mutation");
    }
  };
  await assert.rejects(
    recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "r", actor: "mlx", now: "2026-11-11T10:00:00Z" }),
    /audit write failed/,
  );
  d1.onBeforeRun = null;
  // The terminal UPDATE had already EXECUTED inside the batch — the rollback
  // must remove it: the row is exactly as it started, and "not modified" is
  // the truthful reading of the thrown error.
  const r = row(d1, id);
  assert.equal(r.extraction_state, "captured");
  assert.equal(r.extraction_json, PREEXISTING_JSON);
  assert.equal(r.extraction_processed_at, null);
  assert.equal(audits(d1, id).length, 0);
});

test("R3 render-retry: audit-write failure AFTER the retry UPDATE commits rolls the whole batch back", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_state: "failed", extraction_json: JSON.stringify({ failed: true, reason: "x" }) });
  d1.onBeforeRun = (sql) => {
    if (sql.includes("INSERT INTO receipt_audit_log") && sql.includes("'receipt.render_retry'")) {
      throw new Error("D1_ERROR: audit write failed after mutation");
    }
  };
  await assert.rejects(
    retryRender({ db: d1.asD1(), receiptId: id, actor: "op", now: "2026-11-11T10:00:00Z" }),
    /audit write failed/,
  );
  d1.onBeforeRun = null;
  const r = row(d1, id);
  assert.equal(r.extraction_state, "failed"); // retry rolled back
  assert.equal(r.updated_at, "2026-11-01T00:00:00Z"); // seed value — we wrote nothing
  assert.equal(audits(d1, id).length, 0);
});

// ─── N1: wrong-pipeline rejection must not mutate extraction state ───────────

test("N1 wrong-pipeline rejection (needs_render=0, reviewed, mid-extraction) conflicts WITHOUT touching extraction_state", async () => {
  const d1 = new SqliteD1();
  const id = "wrong-pipe";
  d1.exec(
    `INSERT INTO receipt_records
       (id, status, extraction_state, extraction_json, needs_render, transaction_date,
        original_filename, original_r2_key, captured_at, created_at, updated_at, currency)
     VALUES (?, 'reviewed', 'processing', NULL, 0, NULL, 'img.jpg', 'k2',
             '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'JPY')`,
    id,
  );
  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "r", actor: "mlx" });
  assert.equal(res.kind, "conflict");
  // The row may legitimately be mid-extraction — a wrong-pipeline report
  // must not advance its state (the round-2 code changed this to processed).
  assert.equal(row(d1, id).extraction_state, "processing");
});

test("N1 render-lifecycle rejection still reconciles: reviewed render row with stale pending state → processed + rejected audit", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { status: "reviewed", extraction_state: "queued" });
  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "r", actor: "mlx" });
  assert.equal(res.kind, "conflict");
  assert.equal(row(d1, id).extraction_state, "processed"); // intended fixup
  const rejected = audits(d1, id).filter((a) => a.action === "receipt.render_failed");
  assert.equal(rejected.length, 1);
});

test("N1 deletion race on the rejection fixup: deleted between read and fixup UPDATE → fixup is a no-op", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { status: "reviewed", extraction_state: "queued" });
  d1.onBeforeRun = (sql) => {
    if (sql.includes("SET extraction_state = 'processed'")) {
      d1.exec(`UPDATE receipt_records SET deleted_at = '2026-11-11T00:00:00Z' WHERE id = ?`, id);
    }
  };
  const res = await recordRenderFailure({ db: d1.asD1(), receiptId: id, reason: "r", actor: "mlx" });
  d1.onBeforeRun = null;
  assert.equal(res.kind, "conflict");
  const r = row(d1, id);
  assert.equal(r.extraction_state, "queued"); // WHERE rechecks refused the fixup
  assert.ok(r.deleted_at);
});



test("B4 parseRenderFailedBody boundary matrix", () => {
  const bad = (v: unknown, why: string) => {
    const r = parseRenderFailedBody(v);
    assert.equal(r.ok, false, why);
    assert.notEqual((r as { status: number }).status, 500);
    assert.ok([400, 413].includes((r as { status: number }).status), why);
  };
  bad(42, "number reason value");
  bad(true, "boolean reason value");
  bad(null, "null body");
  bad([], "array body");
  bad("a string body", "string body (not an object)");
  bad({}, "missing reason");
  bad({ reason: 42 }, "numeric reason");
  bad({ reason: null }, "null reason");
  bad({ reason: [] }, "array reason");
  bad({ reason: {} }, "object reason");
  bad({ reason: "   " }, "whitespace-only reason");
  bad({ reason: "x".repeat(1001) }, "over-length reason");

  const ok = parseRenderFailedBody({ reason: "  valid reason  " });
  assert.ok(ok.ok);
  assert.equal(ok.reason, "valid reason"); // trimmed
  const edge = parseRenderFailedBody({ reason: "x".repeat(1000) });
  assert.ok(edge.ok);
});
