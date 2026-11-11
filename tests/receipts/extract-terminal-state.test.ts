import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error node:sqlite is available in Node 22 but not @types/node 20.
import { DatabaseSync } from "node:sqlite";
import type { ReceiptRecord, ReceiptStatus } from "@/lib/receipts/types";

// Real handler and real pending-only reconcile SQL, backed by in-memory SQLite.
function fake(spec: string, exports: Record<string, unknown>) {
  require.cache[require.resolve(spec)] = { exports } as typeof require.cache[string];
}
let sqlite: DatabaseSync;
let reconcileFails: boolean;
let authFails: boolean;
let locked: boolean;
let changes: number[];
let actions: string[];
const db = {
  prepare(sql: string) {
    return {
      bind(...bindings: unknown[]) {
        return {
          async run() {
            if (reconcileFails) throw new Error("D1 reconcile unavailable");
            const result = sqlite.prepare(sql).run(...bindings);
            changes.push(Number(result.changes));
            return { success: true };
          },
        };
      },
    };
  },
};
fake("../../lib/cloudflare-runtime", { getReceiptsDb: () => db, getReceiptsProcessorKey: () => "processor" });
fake("../../lib/receipts/auth", { requireReceiptsActor: async () => {
  if (authFails) throw new Error("Unauthorized");
  return "human";
} });
fake("../../lib/receipts/receipt-locks", { getReceiptLocks: async () => new Map([["r1", { locked }]]) });
fake("../../lib/receipts/compliance", { runComplianceChecksForReceipt: async () => assert.fail("Denied extraction must not refresh compliance") });
fake("../../lib/receipts/settings", { getComplianceSettings: async () => assert.fail("Denied extraction must not load compliance settings") });
fake("../../lib/receipts/audit", { createAuditEntry: async (_db: unknown, entry: { action: string }) => { actions.push(entry.action); } });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { reconcileExtractionState } = require("../../lib/receipts/extraction-queue-db");
fake("../../lib/receipts/db", {
  getReceiptRecord: async () => row(),
  reconcileExtractionState,
  updateReceiptRecord: async () => assert.fail("Denied extraction must not update business fields"),
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require("../../app/api/receipts/[id]/extract/route") as {
  POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response>;
};
function row() {
  return { ...sqlite.prepare("SELECT * FROM receipt_records WHERE id='r1'").get() };
}
function reset(status: ReceiptStatus, state: ReceiptRecord["extraction_state"] | null = "queued", deleted = false) {
  sqlite?.close();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE receipt_records (
    id TEXT PRIMARY KEY, status TEXT, deleted_at TEXT, extraction_state TEXT,
    extraction_processed_at TEXT, updated_at TEXT, merchant TEXT,
    amount_minor INTEGER, extraction_json TEXT
  )`);
  sqlite.prepare("INSERT INTO receipt_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "r1", status, deleted ? "2026-06-10" : null, state ?? null, "prior-processed-at", "prior-updated-at",
    "Operator-confirmed merchant", 9999, '{"rawText":"Original OCR"}',
  );
  reconcileFails = authFails = false; locked = true; changes = []; actions = [];
}
function post(processor = true) {
  return POST(new Request("http://localhost/api/receipts/r1/extract?force=true", {
    method: "POST", headers: processor ? { "x-receipts-processor-key": "processor" } : {},
    body: JSON.stringify({ rawText: "Replacement OCR", fields: { merchant: "Replacement merchant", amountMinor: 1 } }),
  }), { params: Promise.resolve({ id: "r1" }) });
}
test.after(() => sqlite?.close());

for (const status of ["reviewed", "reconciled", "exported", "archived"] as const) {
  test(`locked ${status} receipt heals pending state before 409, preserving business fields and compliance`, async () => {
    for (const state of ["captured", "queued", "processing"] as const) {
      for (const processor of [true, false]) {
        reset(status, state);
        const before = row();
        const response = await post(processor);
        assert.equal(response.status, 409);
        assert.match(((await response.json()) as { error: string }).error, new RegExp(status));
        const after = row();
        assert.equal(after.extraction_state, "processed");
        assert.notEqual(after.extraction_processed_at, before.extraction_processed_at);
        assert.deepEqual(after, { ...before, extraction_state: "processed", extraction_processed_at: after.extraction_processed_at, updated_at: after.updated_at });
        assert.deepEqual(changes, [1]);
        assert.deepEqual(actions, ["receipt.extraction_denied"]);
        assert.equal((await post(processor)).status, 409);
        assert.deepEqual(row(), after, "repeat delivery does not rewrite timestamps or evidence");
        assert.deepEqual(changes, [1, 0]);
      }
    }
  });
}

test("terminal receipts with processed, failed or absent extraction state stay unchanged", async () => {
  for (const state of ["processed", "failed", null] as const) {
    reset("archived", state);
    const before = row();
    assert.equal((await post()).status, 409);
    assert.deepEqual(row(), before);
    assert.deepEqual(changes, [0]);
  }
});

test("deleted receipts are rejected before healing, including archived and exported queued rows", async () => {
  for (const status of ["captured", "needs_review", "reviewed", "reconciled", "exported", "archived"] as const) {
    reset(status, "queued", true);
    const before = row();
    assert.equal((await post()).status, 409);
    assert.deepEqual(row(), before);
    assert.deepEqual(changes, []);
    assert.deepEqual(actions, []);
  }
});

test("sealed captured/needs_review receipts remain rejected with no queue-state or business mutation", async () => {
  for (const status of ["captured", "needs_review"] as const) {
    reset(status);
    const before = row();
    assert.equal((await post()).status, 409);
    assert.deepEqual(row(), before);
    assert.deepEqual(changes, []);
  }
});

test("failed terminal healing returns retryable 500 before permanent 409, and retry succeeds", async () => {
  reset("exported"); reconcileFails = true;
  const before = row();
  assert.equal((await post()).status, 500);
  assert.deepEqual(row(), before);
  assert.deepEqual(actions, []);
  reconcileFails = false;
  assert.equal((await post()).status, 409);
  assert.equal(row().extraction_state, "processed");
  assert.deepEqual(changes, [1]);
});

test("authentication failure cannot heal an archived queued receipt", async () => {
  reset("archived"); authFails = true;
  const before = row();
  assert.equal((await post(false)).status, 401);
  assert.deepEqual(row(), before);
  assert.deepEqual(changes, []);
});
