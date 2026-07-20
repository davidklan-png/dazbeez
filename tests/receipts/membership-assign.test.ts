import test from "node:test";
import assert from "node:assert/strict";
import { assignMembershipForReceipt } from "@/lib/receipts/membership";

// assignMembershipForReceipt takes `db` as a 4th param (testability seam). It
// calls loadSealedExportMonths(db) (→ empty here, so the date's calendar month
// wins), the conditional UPDATE (gated on export_statement_month IS NULL), and —
// only when the UPDATE changes a row — the assignment audit INSERT. The fake D1
// answers loadSealedExportMonths's .all() with no sealed months and the UPDATE's
// .run() with a configurable changes count; .run() calls are recorded.

type Run = { sql: string; args: unknown[] };

function fakeDb(changes: number) {
  const runs: Run[] = [];
  const bound = (sql: string, args: unknown[]) => ({
    async all<T = unknown>(): Promise<{ results?: T[] }> {
      return { results: [] }; // loadSealedExportMonths → no sealed months
    },
    async run() {
      runs.push({ sql, args });
      return { meta: { changes } };
    },
  });
  const db = {
    prepare(sql: string) {
      return {
        // loadSealedExportMonths calls .all() directly (no bind).
        async all<T = unknown>(): Promise<{ results?: T[] }> {
          return { results: [] };
        },
        bind(...args: unknown[]) {
          return bound(sql, args); // UPDATE + audit INSERT bind then run.
        },
      };
    },
  };
  return { db: db as unknown as D1Database, runs };
}

test("assignMembershipForReceipt: UPDATE changes a row → audit written, result returned", async () => {
  const { db, runs } = fakeDb(1);
  const result = await assignMembershipForReceipt("r1", "2026-07-11", "david@example.com", db);
  assert.ok(result, "should return the assignment result when a row changed");
  assert.equal(result!.month, "2026-07");
  assert.equal(result!.reason, "natural");
  assert.ok(
    runs.some((r) => /INSERT INTO receipt_audit_log/i.test(r.sql)),
    "the assignment audit INSERT should fire when a row changed",
  );
});

test("assignMembershipForReceipt: UPDATE changes 0 rows (already assigned / lost race) → NO audit, returns null", async () => {
  const { db, runs } = fakeDb(0);
  const result = await assignMembershipForReceipt("r1", "2026-07-11", "david@example.com", db);
  assert.equal(result, null, "should return null when no row changed");
  assert.ok(
    !runs.some((r) => /INSERT INTO receipt_audit_log/i.test(r.sql)),
    "no false assignment audit when the conditional UPDATE changed 0 rows",
  );
});
