import test from "node:test";
import assert from "node:assert/strict";
import {
  markPreviousArtifactsReplaced,
  purgeFailedAmexArtifactsByHash,
  countCrossMonthDuplicateLines,
} from "@/lib/receipts/db";
import type { ImportAmexLineInput } from "@/lib/receipts/types";

// TASK-037: the 2610 double-import orphaned 23 ghost lines because (A)
// markPreviousArtifactsReplaced flipped the artifact to 'replaced' without
// superseding its lines, and (B) purgeFailedAmexArtifactsByHash then deleted
// the artifact row with no lines-exist guard on the failed/replaced branch.
// These tests pin both fixes plus the advisory cross-month duplicate counter,
// using the fakeDb SQL-capture pattern from
// tests/receipts/exhaustive-read-throw-at-cap.test.ts (opts.db seam): the fake
// dispatches on SQL shape and records every issued statement + binds, so
// WHERE-clause contracts can be asserted, not just return values.

interface Issued {
  sql: string;
  binds: unknown[];
}

interface FakeCfg {
  /** Rows for the markPreviousArtifactsReplaced targets SELECT (id + line_count). */
  replaced?: { id: string; line_count: number }[];
  /** Rows for the purge diagnostic SELECT (failed/replaced rows with counts). */
  failedReplaced?: { id: string; line_count: number }[];
  /** Rows for the purge stale SELECT (id + r2_key). */
  stale?: { id: string; r2_key: string }[];
  /** Rows for the countCrossMonthDuplicateLines DISTINCT read. */
  existing?: {
    statement_month: string;
    transaction_date: string;
    merchant: string;
    amount_minor: number;
    cardholder_name: string | null;
  }[];
}

function fakeDb(cfg: FakeCfg) {
  const queries: Issued[] = [];
  const batches: Issued[][] = [];
  const runs: Issued[] = [];

  function dispatch(sql: string): Record<string, unknown>[] {
    if (/INSERT INTO receipt_audit_log/.test(sql)) return [];
    if (/id != \?/.test(sql) && /line_count/.test(sql)) {
      return [...(cfg.replaced ?? [])];
    }
    if (/line_count/.test(sql) && /import_status IN \('failed', 'replaced'\)/.test(sql)) {
      return [...(cfg.failedReplaced ?? [])];
    }
    if (/SELECT id, r2_key/.test(sql)) return [...(cfg.stale ?? [])];
    if (/statement_month != \?/.test(sql)) return [...(cfg.existing ?? [])];
    return [];
  }

  function prepare(sql: string) {
    const stmt = {
      sql,
      binds: [] as unknown[],
      bind(...args: unknown[]) {
        stmt.binds.push(...args);
        return stmt;
      },
      async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
        queries.push({ sql, binds: stmt.binds });
        return { results: dispatch(sql) as T[], success: true, meta: { changes: 0 } };
      },
      async first<T>(): Promise<T | null> {
        queries.push({ sql, binds: stmt.binds });
        return (dispatch(sql)[0] as T) ?? null;
      },
      async run() {
        runs.push({ sql, binds: stmt.binds });
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  }

  const db = {
    prepare,
    async batch(stmts: { sql: string; binds: unknown[]; run(): Promise<unknown> }[]) {
      const recorded = stmts.map((s) => ({ sql: s.sql, binds: s.binds }));
      batches.push(recorded);
      for (const s of stmts) await s.run();
    },
  };
  return { db: db as unknown as D1Database, queries, batches, runs };
}

function auditEntries(runs: Issued[]) {
  return runs.filter((r) => /INSERT INTO receipt_audit_log/.test(r.sql));
}

// ─── markPreviousArtifactsReplaced ───────────────────────────────────────────

test("markPreviousArtifactsReplaced: deletes lines of flipped artifacts in the same batch as the flip", async () => {
  const fake = fakeDb({
    replaced: [
      { id: "old1", line_count: 23 },
      { id: "old2", line_count: 0 },
    ],
  });
  await markPreviousArtifactsReplaced("2026-10", "new1", "actor-x", { db: fake.db });

  // Targets SELECT is month-scoped, excludes the new artifact, and skips rows
  // already failed/replaced — the flip can never touch another month's or the
  // successor's lines.
  const targets = fake.queries.find((q) => /id != \?/.test(q.sql));
  assert.ok(targets, "targets SELECT issued");
  assert.match(targets.sql, /WHERE statement_month = \? AND id != \? AND import_status NOT IN \('failed','replaced'\)/);
  assert.deepEqual(targets.binds, ["2026-10", "new1"]);

  // One batch of exactly [line DELETE, status flip].
  assert.equal(fake.batches.length, 1);
  const [del, flip] = fake.batches[0];
  assert.match(del.sql, /^DELETE FROM amex_statement_lines WHERE statement_artifact_id IN \(\?, \?\)$/);
  assert.deepEqual(del.binds, ["old1", "old2"]);
  assert.match(flip.sql, /SET import_status = 'replaced'/);
  assert.deepEqual(flip.binds.slice(1), ["2026-10", "new1"]);

  // One audit entry recording every replaced artifact id + its deleted line count.
  const audits = auditEntries(fake.runs);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].binds[2], "amex_statement.replaced_artifact_lines_deleted");
  const payload = JSON.parse(String(audits[0].binds[6]));
  assert.deepEqual(payload.replacedArtifacts, [
    { id: "old1", deletedLines: 23 },
    { id: "old2", deletedLines: 0 },
  ]);
  assert.equal(payload.supersededBy, "new1");
});

test("markPreviousArtifactsReplaced: no prior artifact → no batch, no audit", async () => {
  const fake = fakeDb({ replaced: [] });
  await markPreviousArtifactsReplaced("2026-10", "new1", "actor-x", { db: fake.db });
  assert.equal(fake.batches.length, 0);
  assert.equal(auditEntries(fake.runs).length, 0);
  assert.equal(fake.runs.filter((r) => /DELETE|UPDATE/.test(r.sql)).length, 0);
});

// ─── purgeFailedAmexArtifactsByHash ──────────────────────────────────────────

test("purge: failed/replaced branch carries the NOT EXISTS lines-guard in SQL", async () => {
  const fake = fakeDb({ failedReplaced: [], stale: [] });
  await purgeFailedAmexArtifactsByHash("a".repeat(64), "actor-x", { db: fake.db });
  const staleQuery = fake.queries.find((q) => /SELECT id, r2_key/.test(q.sql));
  assert.ok(staleQuery, "purge SELECT issued");
  assert.match(
    staleQuery.sql,
    /import_status IN \('failed', 'replaced'\)\s+AND NOT EXISTS \(\s+SELECT 1 FROM amex_statement_lines/,
    "the failed/replaced branch must not select artifacts that still own lines",
  );
});

test("purge: an artifact that still owns lines is skipped loudly, never deleted", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const fake = fakeDb({
      failedReplaced: [{ id: "ghost-owner", line_count: 23 }],
      stale: [], // the guarded SELECT excludes it
    });
    await purgeFailedAmexArtifactsByHash("b".repeat(64), "actor-x", { db: fake.db });
    assert.ok(
      errors.some((e) => /REFUSING to purge artifact ghost-owner/.test(e) && /23 statement line/.test(e)),
      `expected a loud skip log naming the artifact and its line count, got: ${JSON.stringify(errors)}`,
    );
    assert.equal(fake.runs.filter((r) => /DELETE FROM amex_statement_artifacts/.test(r.sql)).length, 0);
    assert.equal(auditEntries(fake.runs).length, 0);
  } finally {
    console.error = original;
  }
});

test("purge: line-less failed/replaced artifacts are still purged", async () => {
  const fake = fakeDb({
    failedReplaced: [{ id: "gone1", line_count: 0 }],
    stale: [{ id: "gone1", r2_key: "amex/x.csv" }],
  });
  await purgeFailedAmexArtifactsByHash("c".repeat(64), "actor-x", { db: fake.db });
  const artifactDelete = fake.runs.find((r) => /DELETE FROM amex_statement_artifacts/.test(r.sql));
  assert.ok(artifactDelete, "line-less artifact row deleted");
  assert.deepEqual(artifactDelete.binds, ["gone1"]);
  const audits = auditEntries(fake.runs);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].binds[2], "amex_statement.failed_artifact_purged");
});

// ─── countCrossMonthDuplicateLines ───────────────────────────────────────────

function line(
  transactionDate: string,
  merchant: string,
  amountMinor: number,
  cardholderName: string,
): ImportAmexLineInput {
  return {
    statementMonth: "2026-10",
    transactionDate,
    merchant,
    amountMinor,
    cardholderName,
    rawJson: "{}",
  } as ImportAmexLineInput;
}

test("countCrossMonthDuplicateLines: matches tuples across months, never same-month", async () => {
  const incoming = [
    line("2026-10-02", "HUB 東京オペラシティ", 139500, "DAVID KLAN"),
    line("2026-09-15", "旧タプル", 50000, "DAVID KLAN"),
    line("2026-10-20", "NEW CHARGE", 100, "DAVID KLAN"),
  ];
  const fake = fakeDb({
    existing: [
      // tuple A exists in 2026-09 (cross-month → counts) and 2026-10 itself
      // (same-month = normal re-import dedup → must not count).
      { statement_month: "2026-09", transaction_date: "2026-10-02", merchant: "HUB 東京オペラシティ", amount_minor: 139500, cardholder_name: "DAVID KLAN" },
      { statement_month: "2026-08", transaction_date: "2026-10-02", merchant: "HUB 東京オペラシティ", amount_minor: 139500, cardholder_name: "DAVID KLAN" },
      // tuple B exists in another month → counts.
      { statement_month: "2026-08", transaction_date: "2026-09-15", merchant: "旧タプル", amount_minor: 50000, cardholder_name: "DAVID KLAN" },
      // A null-cardholder row never matches a named-cardholder incoming tuple.
      { statement_month: "2026-07", transaction_date: "2026-10-20", merchant: "NEW CHARGE", amount_minor: 100, cardholder_name: null },
    ],
  });
  const out = await countCrossMonthDuplicateLines(incoming, "2026-10", { db: fake.db });

  // Same-month exclusion lives in the SQL (the fake does not filter), so pin it.
  const read = fake.queries.find((q) => /statement_month != \?/.test(q.sql));
  assert.ok(read, "cross-month read issued");
  assert.match(read.sql, /WHERE statement_month != \?/);
  assert.deepEqual(read.binds, ["2026-10"]);

  assert.equal(out.count, 2);
  assert.deepEqual(out.months, ["2026-08", "2026-09"]);
});

test("countCrossMonthDuplicateLines: empty input short-circuits without querying", async () => {
  const fake = fakeDb({ existing: [] });
  const out = await countCrossMonthDuplicateLines([], "2026-10", { db: fake.db });
  assert.deepEqual(out, { count: 0, months: [] });
  assert.equal(fake.queries.length, 0);
});
