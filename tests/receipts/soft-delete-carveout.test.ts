import test from "node:test";
import assert from "node:assert/strict";
import { softDeleteReceipt } from "@/lib/receipts/db";

// ADR 0012 carve-out for softDeleteReceipt. The function takes `db` as an
// optional 4th param (testability seam, same pattern as unfinalizeReconciliation
// — invisible to the DELETE route, the sole production caller). It issues: a
// SELECT id,status,exported_month; an isMonthLockedForEdits CASE query; a
// deleted_at UPDATE; and an audit INSERT. The recording fake dispatches on SQL.

type Run = { sql: string; args: unknown[] };

function fakeDb(opts: {
  status: string;
  exportedMonth: string | null;
  /** isMonthLockedForEdits result: 0 = open draft (released), 1 = no draft (locked). */
  locked: 0 | 1;
}) {
  const runs: Run[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T = unknown>(): Promise<T | null> {
              if (/SELECT id, status, exported_month FROM receipt_records/i.test(sql)) {
                return { id: "r1", status: opts.status, exported_month: opts.exportedMonth } as T;
              }
              if (/CASE/i.test(sql) && /receipt_exports/i.test(sql)) {
                return { locked: opts.locked } as T;
              }
              return null as T | null;
            },
            async run() {
              runs.push({ sql, args });
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, runs };
}

test("softDeleteReceipt: exported + open draft + reason → soft-deleted, audit written", async () => {
  const { db, runs } = fakeDb({ status: "exported", exportedMonth: "2026-06", locked: 0 });
  await softDeleteReceipt("r1", "david@example.com", "beta review — spurious charge", db);
  const update = runs.find((r) => /UPDATE receipt_records SET deleted_at/i.test(r.sql));
  assert.ok(update, "expected a deleted_at UPDATE");
  const audit = runs.find((r) => /INSERT INTO receipt_audit_log/i.test(r.sql));
  assert.ok(audit, "expected an audit INSERT");
  assert.equal(audit!.args[2], "receipt.deleted"); // action bind position
});

test("softDeleteReceipt: exported + no draft (locked) → throws, writes nothing", async () => {
  const { db, runs } = fakeDb({ status: "exported", exportedMonth: "2026-06", locked: 1 });
  await assert.rejects(
    softDeleteReceipt("r1", "david@example.com", "reason", db),
    /cannot be deleted/i,
  );
  assert.equal(runs.length, 0, "no UPDATE or audit should fire when the month is locked");
});

test("softDeleteReceipt: exported + open draft + NO reason → throws (reason mandatory for exported)", async () => {
  const { db, runs } = fakeDb({ status: "exported", exportedMonth: "2026-06", locked: 0 });
  await assert.rejects(
    softDeleteReceipt("r1", "david@example.com", undefined, db),
    /requires a non-empty reason/i,
  );
  assert.equal(runs.length, 0, "no UPDATE or audit should fire without a reason");
});

test("softDeleteReceipt: reviewed (deletable) → deletes without a reason/draft (existing behavior preserved)", async () => {
  const { db, runs } = fakeDb({ status: "reviewed", exportedMonth: null, locked: 1 });
  await softDeleteReceipt("r1", "david@example.com", undefined, db);
  const update = runs.find((r) => /UPDATE receipt_records SET deleted_at/i.test(r.sql));
  assert.ok(update, "a reviewed receipt should soft-delete without a reason or draft");
});
