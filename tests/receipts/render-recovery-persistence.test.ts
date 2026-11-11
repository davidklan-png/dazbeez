// Real-engine persistence tests for the render-recovery core (round-2 review
// B1–B4): recordRenderFailure / retryRender run against a REAL SQLite database
// (node:sqlite DatabaseSync) through a minimal D1-compatible shim, so the
// actual SQL — atomicity, WHERE-boundary admission re-checks, affected-rows
// inspection, seal guards — is executed, not mocked.
//
// Race windows are simulated at the SQL boundary: the shim exposes
// `onBeforeRun`, a hook that fires immediately before each mutating statement
// executes, letting a test mutate the row BETWEEN the function's read and its
// conditional write — the exact interleavings the review reproduced.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeTerminalRenderPayload,
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

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(SCHEMA);
  }

  /** Raw escape hatch for fixture setup / race mutations. */
  exec(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>(): Promise<T | null> => {
          const row = this.db.prepare(sql).get(...args);
          return (row ?? null) as T | null;
        },
        all: async <T>(): Promise<{ results: T[] }> => {
          const rows = this.db.prepare(sql).all(...args);
          return { results: rows as T[] };
        },
        run: async (): Promise<{ success: true; meta: { changes: number } }> => {
          if (this.onBeforeRun && /^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) {
            this.onBeforeRun(sql);
          }
          const info = this.db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
      }),
    };
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
  d1.exec(
    `INSERT INTO receipt_records
       (id, status, extraction_state, extraction_json, needs_render, transaction_date,
        original_filename, original_r2_key, captured_at, created_at, updated_at, currency)
     VALUES (?, ?, ?, ?, 1, NULL, 'body.html', 'k', '2026-11-01T00:00:00Z',
             '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'JPY')`,
    id,
    overrides.status ?? "captured",
    overrides.extraction_state ?? "captured",
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

test("B1 mergeTerminalRenderPayload: malformed / array / null existing JSON → fresh payload only", () => {
  const fresh = JSON.parse(mergeTerminalRenderPayload(null, "r", "t"));
  assert.equal(fresh.reason, "r");
  const fromArray = JSON.parse(mergeTerminalRenderPayload("[1,2]", "r", "t"));
  assert.equal(fromArray.failed, true);
  assert.equal(Object.keys(fromArray).length, 4); // no array items smeared in
});

// ─── B2: atomic commit + rollback ────────────────────────────────────────────

test("B2 terminal state and reason commit in ONE statement — injected write failure leaves the row untouched", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_json: PREEXISTING_JSON });
  // Fail the terminal UPDATE itself (models D1 error mid-write).
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

test("B3 zero-change double retry: second call is an honest conflict, never a false success", async () => {
  const d1 = new SqliteD1();
  const id = seedRenderRow(d1, { extraction_state: "failed", extraction_json: JSON.stringify({ failed: true }) });
  assert.equal((await retryRender({ db: d1.asD1(), receiptId: id, actor: "op" })).kind, "retrying");
  const second = await retryRender({ db: d1.asD1(), receiptId: id, actor: "op" });
  assert.equal(second.kind, "conflict");
  assert.match((second as { error: string }).error, /extraction_state='captured'/);
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

// ─── B4: request-body runtime-type boundary matrix ──────────────────────────

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
