import test from "node:test";
import assert from "node:assert/strict";
import {
  createDelivery,
  markDeliveryAmbiguous,
  markDeliveryFailed,
  markDeliverySent,
} from "@/lib/receipts/db";
import type { CreateDeliveryInput } from "@/lib/receipts/db";

// Tier-1 documented-but-untested invariants (docs/audits/2026-08-backlog-questions.md
// §6), ranked by blast radius on a sealed/delivered month. Each test FAILS if the
// invariant's enforcement is removed (fail-then-pass verified). The opts.db seam
// (same convention as softDeleteReceipt / unfinalizeReconciliation / the T1-7
// throw-at-cap test) makes these D1-coupled functions unit-testable.

/** A recording fake D1: captures every statement passed to db.batch([...]) as
 *  its SQL string, and every standalone prepare().run() in `runs`, so tests can
 *  assert on what a function wrote (and what it did NOT write) without
 *  bindings. */
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

// ─── Seal-invariant policy: an ALLOWLIST, not a denylist ─────────────────────
// (Codex P2 #1, PR #183: a sealed-column denylist can't catch writes to
// *unlisted* seal-related fields like `status` or `finalized_by`.) A delivery
// wrapper may write ONLY the delivery-reporting fields its SQL in db.ts
// actually touches — enumerated below from that SQL. Anything else on the
// sealed receipt_exports row fails.

/** The ONLY receipt_exports column any of the four wrappers ever SETs. */
const ALLOWED_EXPORTS_SET_COLUMNS = new Set(["delivery_state"]);

/** export_deliveries SET columns across markDeliverySent/Failed/Ambiguous. */
const ALLOWED_DELIVERY_SET_COLUMNS = new Set([
  "state",
  "provider_message_id",
  "error",
  "completed_at",
]);

/** export_deliveries INSERT columns (createDelivery's column list). */
const ALLOWED_DELIVERY_INSERT_COLUMNS = new Set([
  "id",
  "export_id",
  "attempt_id",
  "idempotency_key",
  "state",
  "to_address",
  "cc_address",
  "subject",
  "body",
  "operator_message",
  "zip_filename",
  "zip_sha256",
  "zip_bytes",
  "created_at",
]);

/** Assert one recorded SQL statement only writes delivery-reporting fields. */
function assertStatementAllowed(wrapper: string, sql: string) {
  const update =
    /^UPDATE\s+(receipt_exports|export_deliveries)\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|$)/i.exec(
      sql,
    );
  if (update) {
    const [, table, setClause] = update;
    const allowed =
      table === "receipt_exports"
        ? ALLOWED_EXPORTS_SET_COLUMNS
        : ALLOWED_DELIVERY_SET_COLUMNS;
    for (const col of setClause.split(",").map((c) => c.split("=")[0].trim())) {
      assert.ok(
        allowed.has(col.toLowerCase()),
        `${wrapper}: ${table} write touches non-allowlisted column "${col}" ` +
          `(allowed: ${[...allowed].join(", ")});\n  ${sql}`,
      );
    }
    return;
  }
  const insert = /^INSERT\s+INTO\s+export_deliveries\s*\(([^)]*)\)/i.exec(sql);
  if (insert) {
    for (const col of insert[1].split(",").map((c) => c.trim())) {
      assert.ok(
        ALLOWED_DELIVERY_INSERT_COLUMNS.has(col.toLowerCase()),
        `${wrapper}: export_deliveries INSERT touches non-allowlisted column ` +
          `"${col}" (allowed: ${[...ALLOWED_DELIVERY_INSERT_COLUMNS].join(", ")});\n  ${sql}`,
      );
    }
    return;
  }
  // Not an allowed INSERT/UPDATE shape, yet it touches the delivery/export
  // rows at all (e.g. INSERT INTO receipt_exports, DELETE FROM either table).
  assert.ok(
    !/\b(receipt_exports|export_deliveries)\b/i.test(sql),
    `${wrapper} touches the sealed/delivery rows with an unexpected statement:\n  ${sql}`,
  );
}

/** Full seal-invariant check for one wrapper's recorded activity. */
function assertSealSafe(
  wrapper: string,
  batches: string[][],
  runs: string[],
): string {
  // Standalone writes: nothing may touch the delivery/export rows outside the
  // one db.batch — a wrapper mutating a sealed field via a standalone
  // prepare().run() before or after its batch must not stay green.
  for (const sql of runs) {
    assert.ok(
      !/\b(receipt_exports|export_deliveries)\b/i.test(sql),
      `${wrapper} must not touch the delivery/export rows outside db.batch; ` +
        `saw standalone write:\n  ${sql}`,
    );
  }
  // Allowlist on every batched statement.
  for (const sql of batches.flat()) assertStatementAllowed(wrapper, sql);
  return batches.flat().join("\n  ");
}

function deliveryInput(): CreateDeliveryInput {
  return {
    exportId: "exp-1",
    attemptId: "att-1",
    idempotencyKey: "key-1",
    toAddress: "accountant@example.com",
    ccAddress: null,
    subject: "2026-10 領収証",
    body: "body",
    operatorMessage: null,
    zipFilename: "2026-10.zip",
    zipSha256: "a".repeat(64),
    zipBytes: 1234,
  };
}

// ─── T1-6 (rank 1) — a failed send never touches the seal ────────────────────

for (const [name, call] of [
  ["markDeliverySent", (db: D1Database) => markDeliverySent("att-1", "msg-id", db)],
  ["markDeliveryFailed", (db: D1Database) => markDeliveryFailed("att-1", "boom", db)],
  ["markDeliveryAmbiguous", (db: D1Database) => markDeliveryAmbiguous("att-1", "timeout", db)],
  ["createDelivery", (db: D1Database) => createDelivery(deliveryInput(), db)],
] as const) {
  test(`T1-6: ${name} touches only delivery-reporting fields — never the sealed row, never standalone`, async () => {
    const { db, batches, runs } = recordingDb();
    await call(db);
    const sql = assertSealSafe(name, batches, runs);
    // Positive anchor: it DOES move the reporting state.
    assert.ok(/delivery_state\s*=\s*'/.test(sql), `${name} sets delivery_state`);
  });
}

// ─── T1-5 (rank 5) — delivery_state is written in the SAME batch as the attempt ──

for (const [name, call, attemptStmt] of [
  ["markDeliverySent", (db: D1Database) => markDeliverySent("att-1", "msg-id", db), /UPDATE export_deliveries/i],
  ["markDeliveryFailed", (db: D1Database) => markDeliveryFailed("att-1", "boom", db), /UPDATE export_deliveries/i],
  ["markDeliveryAmbiguous", (db: D1Database) => markDeliveryAmbiguous("att-1", "timeout", db), /UPDATE export_deliveries/i],
  ["createDelivery", (db: D1Database) => createDelivery(deliveryInput(), db), /INSERT INTO export_deliveries/i],
] as const) {
  test(`T1-5: ${name} writes the attempt row + receipt_exports.delivery_state in ONE db.batch`, async () => {
    const { db, batches } = recordingDb();
    await call(db);
    assert.equal(batches.length, 1, "the two writes are a single db.batch (transaction)");
    const [stmts] = batches;
    assert.equal(stmts.length, 2, "exactly two statements — the attempt statement + the delivery_state UPDATE");
    assert.ok(
      stmts.some((s) => attemptStmt.test(s)),
      "the attempt statement (INSERT/UPDATE export_deliveries) is in the batch",
    );
    assert.ok(
      stmts.some((s) => /UPDATE receipt_exports/i.test(s) && /delivery_state/i.test(s)),
      "the receipt_exports.delivery_state UPDATE is in the SAME batch",
    );
  });
}
