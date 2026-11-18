import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { intakeJulianSql, INTAKE_ACTIVITY_SQL, parseIntakeTime } from "@/lib/receipts/intake-time";
import { getSenderControlsSnapshot } from "@/lib/receipts/sender-activity";

function assertD1Patterns(sql: string) {
  const patterns = [...sql.matchAll(/\b(?:LIKE|GLOB)\s+'((?:''|[^'])*)'/gi)];
  for (const [, literal] of patterns) {
    assert.ok(Buffer.byteLength(literal.replaceAll("''", "'"), "utf8") <= 50, "D1 LIKE/GLOB pattern exceeds 50 bytes");
  }
  return patterns.length;
}

// Python exposes SQLite's runtime pattern limit; node:sqlite does not.
function query(sql: string, args: unknown[] = [], setup: string[] = []): Record<string, string | number | null>[] {
  const result = spawnSync("python3", ["-c", `
import json, sqlite3, sys
job = json.load(sys.stdin)
with sqlite3.connect(":memory:") as db:
    db.row_factory = sqlite3.Row
    db.setlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 50)
    assert db.getlimit(sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH) == 50
    for sql in job["setup"]:
        db.executescript(sql)
    print(json.dumps([dict(row) for row in db.execute(job["sql"], job["args"])]))
`], { input: JSON.stringify({ sql, args, setup }), encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout);
}

test("every emitted LIKE/GLOB literal fits D1's 50 UTF-8 byte limit; runtime rejects overlong patterns", () => {
  for (const operator of ["LIKE", "GLOB"]) {
    for (const literal of ["x".repeat(51), "é".repeat(26)]) {
      const sql = `SELECT 'x' ${operator} '${literal}'`;
      assert.throws(() => assertD1Patterns(sql), /50 bytes/);
      assert.throws(() => query(sql), /LIKE or GLOB pattern too complex/);
    }
    assert.doesNotThrow(() => query(`SELECT 'x' ${operator} '${"x".repeat(50)}'`));
  }
  for (const sql of [intakeJulianSql("v"), INTAKE_ACTIVITY_SQL]) assert.ok(assertD1Patterns(sql) > 0);
});

const cases = JSON.parse(readFileSync("tests/fixtures/intake-arrival-times.json", "utf8")) as { name: string; arrival: string | null; valid: boolean }[];
for (const c of cases) test(`D1-limited actual SQL/TS timestamp parity: ${c.name}`, () => {
  const sql = `WITH t(v) AS (VALUES (?)) SELECT ${intakeJulianSql("v")} AS instant FROM t`;
  assertD1Patterns(sql);
  const [{ instant }] = query(sql, [c.arrival]);
  const ms = parseIntakeTime(c.arrival);
  assert.equal(ms !== null, c.valid);
  assert.equal(instant !== null, c.valid);
  if (ms !== null) {
    assert.equal(typeof instant, "number");
    assert.ok(Math.abs((Number(instant) - 2440587.5) * 86400000 - ms) < 1);
  }
});

test("actual Sender controls snapshot evaluates legacy and blocked activity under D1's runtime pattern limit", async () => {
  const setup = readdirSync("db/receipts").filter(f => f.endsWith(".sql")).sort()
    .map(f => readFileSync(`db/receipts/${f}`, "utf8"));
  setup.push(`INSERT INTO blocked_intake_senders VALUES ('blocked@example.invalid', 'fixture', '2020-01-01T00:00:00Z');
    INSERT INTO email_receipt_intake (id, from_address, arrived_at, created_at, received_at, blocked_sender_email) VALUES
    ('legacy', 'unknown@example.invalid', NULL, '2020-03-01T09:00:00+09:00', '2099-01-01T00:00:00Z', NULL),
    ('corrupt', 'unknown@example.invalid', 'invalid', '2020-04-01T00:00:00Z', '2099-01-01T00:00:00Z', NULL),
    ('blocked', 'blocked@example.invalid', '2020-05-01T00:00:00Z', '2020-06-01T00:00:00Z', '2099-01-01T00:00:00Z', 'blocked@example.invalid'),
    ('blocked-corrupt', 'blocked@example.invalid', '2020-01-01T24:00:00Z', '2020-06-01T00:00:00Z', '2099-01-01T00:00:00Z', 'blocked@example.invalid');`);
  const db = { prepare(sql: string) {
    assertD1Patterns(sql);
    const make = (args: unknown[]) => ({
      bind: (...values: unknown[]) => make(values),
      all: async () => ({ results: query(sql, args, setup) }),
    });
    return make([]);
  } } as unknown as D1Database;
  const snapshot = await getSenderControlsSnapshot(db);
  assert.deepEqual(snapshot.trusted, []);
  assert.equal(snapshot.unrecognized.length, 1);
  const [unknown] = snapshot.unrecognized;
  assert.equal(unknown.from_address, "unknown@example.invalid");
  assert.equal(unknown.total, 2);
  assert.equal(unknown.legacy_count, 1);
  assert.equal(unknown.unavailable_count, 1);
  assert.equal(unknown.first_received, "2020-03-01T00:00:00.000Z");
  assert.equal(unknown.latest_received, unknown.first_received);
  assert.equal(snapshot.blocked.length, 1);
  assert.equal(snapshot.blocked[0].blocked_delivery_count, 2);
  assert.equal(snapshot.blocked[0].legacy_count, 0);
  assert.equal(snapshot.blocked[0].unavailable_count, 1);
  assert.equal(snapshot.blocked[0].latest_blocked_delivery, "2020-05-01T00:00:00.000Z");
});
