import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — node:sqlite is available at runtime in Node 22.5+ but not
// typed by @types/node 20 (same convention as duplicate-purge.test.ts).
import { DatabaseSync } from "node:sqlite";
import { createAttendees, replaceAmexLineAttendees } from "@/lib/receipts/db";

// Audit finding 2 regressions — the two roster REPLACEMENT writers, exercised
// against real SQLite (constraints + transactions), not mock batch calls:
//   1. a failed middle INSERT rolls the whole replacement back (old roster
//      survives, no audit entry);
//   2. two concurrent complete replacements leave ONE complete intended
//      roster, never a mix — and a sequential delete-then-insert replica of
//      the pre-fix code DOES mix under the same interleaving (teeth proof).
// Also pins the preserved semantics: empty roster, statement order, duplicate
// names, finalized-month guard, audit entry, read-count consistency.

function setupTestDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON"); // D1 enforces FKs
  sqlite.exec(`
    CREATE TABLE receipt_records (id TEXT PRIMARY KEY);
    -- Real 0001 DDL (FK + NOT NULLs the rollback regressions rely on).
    CREATE TABLE receipt_attendees (
      id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL REFERENCES receipt_records(id) ON DELETE CASCADE,
      attendee_name TEXT NOT NULL,
      company TEXT,
      relationship TEXT,
      is_dazbeez_employee INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE amex_statement_lines (
      id TEXT PRIMARY KEY,
      statement_month TEXT NOT NULL,
      transaction_date TEXT NOT NULL DEFAULT '',
      merchant TEXT NOT NULL DEFAULT '',
      amount_minor INTEGER NOT NULL DEFAULT 0
    );
    -- Real 0005 DDL.
    CREATE TABLE amex_line_attendees (
      id TEXT PRIMARY KEY,
      amex_statement_line_id TEXT NOT NULL REFERENCES amex_statement_lines(id) ON DELETE CASCADE,
      attendee_name TEXT NOT NULL,
      company TEXT,
      relationship TEXT,
      is_dazbeez_employee INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE amex_reconciliations (
      id TEXT PRIMARY KEY, statement_month TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE receipt_audit_log (
      id TEXT PRIMARY KEY, actor TEXT, action TEXT, object_type TEXT,
      object_id TEXT, old_value_json TEXT, new_value_json TEXT, created_at TEXT
    );
    INSERT INTO receipt_records (id) VALUES ('r1');
    INSERT INTO amex_statement_lines (id, statement_month) VALUES ('line1', '2026-08');
    INSERT INTO amex_statement_lines (id, statement_month) VALUES ('lineSealed', '2026-05');
    INSERT INTO amex_reconciliations (id, statement_month, status)
      VALUES ('rec1', '2026-05', 'finalized');
  `);
  return sqlite;
}

/**
 * Minimal D1 shape over real SQLite, modeling the two D1 execution modes the
 * fix depends on:
 *  - standalone prepare().run()/.first()/.all() each AWAIT a macrotask — a
 *    separate round-trip, so two in-flight writers interleave between
 *    statements (the pre-fix hazard);
 *  - batch() executes all statements SYNCHRONOUSLY inside BEGIN…COMMIT with
 *    ROLLBACK on any error — D1's implicit transaction, uninterleavable from
 *    the same event loop.
 */
function d1Adapter(sqlite: DatabaseSync): D1Database {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  function prepare(sql: string) {
    const stmt = {
      sql,
      params: [] as unknown[],
      bind(...args: unknown[]) {
        stmt.params = args;
        return stmt;
      },
      async run() {
        await tick();
        sqlite.prepare(sql).run(...(stmt.params as never[]));
        return { success: true as const, meta: { changes: 1 } };
      },
      async first<T>(): Promise<T | null> {
        await tick();
        return (sqlite.prepare(sql).get(...(stmt.params as never[])) as T) ?? null;
      },
      async all<T>() {
        await tick();
        return {
          results: sqlite.prepare(sql).all(...(stmt.params as never[])) as T[],
          success: true as const,
          meta: { changes: 0 },
        };
      },
    };
    return stmt;
  }
  const db = {
    prepare,
    async batch(stmts: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        for (const s of stmts) sqlite.prepare(s.sql).run(...(s.params as never[]));
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return stmts.map(() => ({ success: true as const, meta: { changes: 1 } }));
    },
  };
  return db as unknown as D1Database;
}

/** Roster in statement/insert order (readers use created_at ASC; one shared
 *  `now` per replacement, so rowid order IS the stored order). */
function receiptRoster(sqlite: DatabaseSync): string[] {
  return (sqlite
    .prepare("SELECT attendee_name FROM receipt_attendees WHERE receipt_id = 'r1' ORDER BY rowid")
    .all() as { attendee_name: string }[]).map((r) => r.attendee_name);
}

function lineRoster(sqlite: DatabaseSync, lineId: string): string[] {
  return (sqlite
    .prepare(
      "SELECT attendee_name FROM amex_line_attendees WHERE amex_statement_line_id = ? ORDER BY rowid",
    )
    .all(lineId) as { attendee_name: string }[]).map((r) => r.attendee_name);
}

function auditCount(sqlite: DatabaseSync, objectId: string): number {
  return (sqlite
    .prepare("SELECT COUNT(*) AS n FROM receipt_audit_log WHERE object_id = ?")
    .get(objectId) as { n: number }).n;
}

const names = (arr: string[]) => arr.map((attendeeName) => ({ attendeeName }));

// ─── Rollback: failed middle INSERT leaves the previous roster intact ────────

test("createAttendees: failed middle insert rolls back to previous roster, no audit", async () => {
  const sqlite = setupTestDb();
  const db = d1Adapter(sqlite);
  await createAttendees("r1", names(["Old1", "Old2"]), "op", db);

  await assert.rejects(
    createAttendees(
      "r1",
      [
        { attendeeName: "X" },
        // NOT NULL constraint fires on the middle statement.
        { attendeeName: null as unknown as string },
        { attendeeName: "Y" },
      ],
      "op",
      db,
    ),
    /NOT NULL constraint failed/,
  );

  assert.deepEqual(receiptRoster(sqlite), ["Old1", "Old2"]); // NOT X, [], or Y
  assert.equal(auditCount(sqlite, "r1"), 1); // only the seed entry — failed replace audited nothing
});

test("replaceAmexLineAttendees: failed middle insert rolls back to previous roster, no audit", async () => {
  const sqlite = setupTestDb();
  const db = d1Adapter(sqlite);
  await replaceAmexLineAttendees("line1", ["Keep1"], "op", db);

  await assert.rejects(
    replaceAmexLineAttendees("line1", ["P", null as unknown as string, "Q"], "op", db),
    /NOT NULL constraint failed/,
  );

  assert.deepEqual(lineRoster(sqlite, "line1"), ["Keep1"]);
  assert.equal(auditCount(sqlite, "line1"), 1);
});

// ─── Concurrency: one complete intended roster, never a mix ──────────────────

/** Teeth: the pre-fix sequential delete-then-await-inserts shape, so the
 *  concurrency assertions below are proven non-vacuous — this replica MUST
 *  mix under the same interleaving the real writers face. */
async function oldSequentialReplace(db: D1Database, names_: string[]): Promise<void> {
  await db.prepare(`DELETE FROM receipt_attendees WHERE receipt_id = 'r1'`).run();
  for (const n of names_) {
    await db
      .prepare(
        `INSERT INTO receipt_attendees (id, receipt_id, attendee_name, created_at)
         VALUES (?, 'r1', ?, 'now')`,
      )
      .bind(`old-${n}`, n)
      .run();
  }
}

test("teeth: pre-fix sequential replacement DOES mix under concurrency", async () => {
  const sqlite = setupTestDb();
  const db = d1Adapter(sqlite);
  await Promise.all([
    oldSequentialReplace(db, ["A1", "A2"]),
    oldSequentialReplace(db, ["B1", "B2"]),
  ]);
  // Both DELETEs land before the INSERTs interleave → the union, a mix.
  assert.deepEqual(receiptRoster(sqlite), ["A1", "B1", "A2", "B2"]);
});

test("createAttendees: concurrent replacements leave one complete roster, never a mix", async () => {
  const sqlite = setupTestDb();
  const db = d1Adapter(sqlite);
  await Promise.all([
    createAttendees("r1", names(["A1", "A2"]), "op", db),
    createAttendees("r1", names(["B1", "B2", "B3"]), "op", db),
  ]);
  const roster = receiptRoster(sqlite);
  const complete = roster.length === 2 || roster.length === 3;
  assert.ok(complete, `expected a complete roster, got ${JSON.stringify(roster)}`);
  assert.ok(
    JSON.stringify(roster) === JSON.stringify(["A1", "A2"]) ||
      JSON.stringify(roster) === JSON.stringify(["B1", "B2", "B3"]),
    `expected exactly roster A or roster B, got ${JSON.stringify(roster)}`,
  );
});

test("replaceAmexLineAttendees: concurrent replacements leave one complete roster, never a mix", async () => {
  const sqlite = setupTestDb();
  const db = d1Adapter(sqlite);
  await Promise.all([
    replaceAmexLineAttendees("line1", ["A1", "A2"], "op", db),
    replaceAmexLineAttendees("line1", ["B1", "B2", "B3"], "op", db),
  ]);
  const roster = lineRoster(sqlite, "line1");
  assert.ok(
    JSON.stringify(roster) === JSON.stringify(["A1", "A2"]) ||
      JSON.stringify(roster) === JSON.stringify(["B1", "B2", "B3"]),
    `expected exactly roster A or roster B, got ${JSON.stringify(roster)}`,
  );
});

// ─── Preserved semantics ──────────────────────────────────────────────────────

test("createAttendees: empty roster clears via DELETE-only batch, order + duplicates preserved otherwise", async () => {
  const sqlite = setupTestDb();
  const db = d1Adapter(sqlite);

  await createAttendees("r1", names(["Zed", "Dup", "Dup", "Ann"]), "op", db);
  assert.deepEqual(receiptRoster(sqlite), ["Zed", "Dup", "Dup", "Ann"]); // duplicates = different people
  assert.equal(
    (sqlite.prepare("SELECT COUNT(*) AS n FROM receipt_attendees WHERE receipt_id = 'r1'").get() as { n: number }).n,
    4, // read/export count consistency: stored count == submitted count
  );

  await createAttendees("r1", [], "op", db); // empty roster: DELETE-only batch commits
  assert.deepEqual(receiptRoster(sqlite), []);
  assert.equal(auditCount(sqlite, "r1"), 2); // both successful replacements audited

  const audits = sqlite
    .prepare("SELECT action, new_value_json FROM receipt_audit_log WHERE object_id = 'r1' ORDER BY rowid")
    .all() as { action: string; new_value_json: string }[];
  assert.equal(audits[0]!.action, "receipt.updated");
  assert.equal(JSON.parse(audits[0]!.new_value_json).attendees.join(","), "Zed,Dup,Dup,Ann");
});

test("replaceAmexLineAttendees: empty roster clears, order + duplicates + audit preserved", async () => {
  const sqlite = setupTestDb();
  const db = d1Adapter(sqlite);

  await replaceAmexLineAttendees("line1", ["Zed", "Dup", "Dup"], "op", db);
  assert.deepEqual(lineRoster(sqlite, "line1"), ["Zed", "Dup", "Dup"]);

  await replaceAmexLineAttendees("line1", [], "op", db);
  assert.deepEqual(lineRoster(sqlite, "line1"), []);
  const audit = sqlite
    .prepare("SELECT new_value_json FROM receipt_audit_log WHERE object_id = 'line1' ORDER BY rowid")
    .all() as { new_value_json: string }[];
  assert.equal(audit[1]!.new_value_json, JSON.stringify({ attendees: [] }));
});

test("replaceAmexLineAttendees: finalized-month guard still blocks before any write", async () => {
  const sqlite = setupTestDb();
  const db = d1Adapter(sqlite);
  // Seed directly — the guard (correctly) blocks the writer on a sealed month.
  sqlite
    .prepare(
      `INSERT INTO amex_line_attendees (id, amex_statement_line_id, attendee_name, created_at, updated_at)
       VALUES ('pre1', 'lineSealed', 'Pre', 'now', 'now')`,
    )
    .run();

  await assert.rejects(
    replaceAmexLineAttendees("lineSealed", ["Blocked1", "Blocked2"], "op", db),
    /is finalized/,
  );
  assert.deepEqual(lineRoster(sqlite, "lineSealed"), ["Pre"]);
  assert.equal(auditCount(sqlite, "lineSealed"), 0);
});
