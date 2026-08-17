import test from "node:test";
import assert from "node:assert/strict";
import {
  markDeliveryAmbiguous,
  markDeliveryFailed,
  markDeliverySent,
} from "@/lib/receipts/db";

// Tier-1 documented-but-untested invariants (docs/audits/2026-08-backlog-questions.md
// §6), ranked by blast radius on a sealed/delivered month. Each test FAILS if the
// invariant's enforcement is removed (fail-then-pass verified). The opts.db seam
// (same convention as softDeleteReceipt / unfinalizeReconciliation / the T1-7
// throw-at-cap test) makes these D1-coupled functions unit-testable.

/** A recording fake D1: captures every statement passed to db.batch([...]) as
 *  its SQL string, so tests can assert on what a function wrote (and what it did
 *  NOT write) without bindings. */
function recordingDb() {
  const batches: string[][] = [];
  const runs: string[] = [];
  function prepare(sql: string) {
    const stmt = {
      _sql: sql,
      bind(..._args: unknown[]) {
        return this;
      },
      async all<T = unknown>() {
        return { results: [] as T[], success: true as const, meta: { changes: 0 } };
      },
      async first<T = unknown>(): Promise<T | null> {
        return null;
      },
      async run() {
        runs.push(this._sql);
        return { success: true as const, meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  const db = {
    prepare,
    async batch(stmts: ReturnType<typeof prepare>[]) {
      batches.push(stmts.map((s) => s._sql));
      return stmts.map(() => ({ success: true as const, meta: { changes: 1 } }));
    },
  };
  return { db: db as unknown as D1Database, batches, runs };
}

// The sealed-bundle identity columns. A delivery mutation must never touch any.
const SEALED_COLUMNS = [
  "archive_r2_key",
  "manifest_r2_key",
  "archive_sha256",
  "manifest_sha256",
  "proofs_r2_key",
  "proofs_sha256",
  "finalization_hash",
  "finalized_at",
];

// ─── T1-6 (rank 1) — a failed send never touches the seal ────────────────────

for (const [name, call] of [
  ["markDeliverySent", (db: D1Database) => markDeliverySent("att-1", "msg-id", db)],
  ["markDeliveryFailed", (db: D1Database) => markDeliveryFailed("att-1", "boom", db)],
  ["markDeliveryAmbiguous", (db: D1Database) => markDeliveryAmbiguous("att-1", "timeout", db)],
] as const) {
  test(`T1-6: ${name} touches only delivery_state — never a sealed-bundle column`, async () => {
    const { db, batches } = recordingDb();
    await call(db);
    const sql = batches.flat().join("\n  ");
    for (const col of SEALED_COLUMNS) {
      assert.ok(
        !sql.includes(col),
        `${name} must not write sealed column ${col}; saw:\n  ${sql}`,
      );
    }
    // Positive anchor: it DOES move the reporting state.
    assert.ok(/delivery_state\s*=\s*'/.test(sql), `${name} sets delivery_state`);
  });
}

// ─── T1-5 (rank 5) — delivery_state is written in the SAME batch as the attempt ──

for (const [name, call] of [
  ["markDeliverySent", (db: D1Database) => markDeliverySent("att-1", "msg-id", db)],
  ["markDeliveryFailed", (db: D1Database) => markDeliveryFailed("att-1", "boom", db)],
  ["markDeliveryAmbiguous", (db: D1Database) => markDeliveryAmbiguous("att-1", "timeout", db)],
] as const) {
  test(`T1-5: ${name} writes the attempt row + receipt_exports.delivery_state in ONE db.batch`, async () => {
    const { db, batches } = recordingDb();
    await call(db);
    assert.equal(batches.length, 1, "the two writes are a single db.batch (transaction)");
    const [stmts] = batches;
    assert.equal(stmts.length, 2, "exactly two statements — the attempt UPDATE + the delivery_state UPDATE");
    assert.ok(
      stmts.some((s) => /UPDATE export_deliveries/i.test(s)),
      "the attempt row UPDATE is in the batch",
    );
    assert.ok(
      stmts.some((s) => /UPDATE receipt_exports/i.test(s) && /delivery_state/i.test(s)),
      "the receipt_exports.delivery_state UPDATE is in the SAME batch",
    );
  });
}
