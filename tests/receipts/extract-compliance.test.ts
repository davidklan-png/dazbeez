import test from "node:test";
import assert from "node:assert/strict";
import type { ReceiptRecord, UpdateReceiptInput } from "@/lib/receipts/types";
import { COMPLIANCE_DEFAULTS } from "@/lib/receipts/settings";
import { buildReceiptUpdateSets } from "@/lib/receipts/db";
import { ExportFinalizedError } from "@/lib/receipts/month-lock";

// Real handler + canonical compliance engine; isolate I/O in this test process.
function fake(spec: string, exports: Record<string, unknown>) {
  require.cache[require.resolve(spec)] = { exports } as typeof require.cache[string];
}
let receipt: ReceiptRecord;
let openChecks: Set<string>;
let batchFails: boolean;
let finishFails: boolean;
let locked: boolean;
let authFails: boolean;
let deferDate: boolean;
let batchCount: number;
let updates: UpdateReceiptInput[];
let actions: string[];
let events: string[];
const db = {
  prepare(sql: string) {
    let binds: unknown[] = [];
    return {
      bind(...args: unknown[]) { binds = args; return this; },
      async first() { return receipt; },
      async all() {
        if (sql.includes("receipt_compliance_checks")) {
          return { results: [...openChecks].map((type) => ({ id: type, check_type: type, status: "open" })) };
        }
        if (sql.includes("receipt_attendees")) return { results: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
      sql,
      get binds() { return binds; },
    };
  },
  async batch(statements: Array<{ sql: string; binds: unknown[] }>) {
    batchCount++;
    if (batchFails) throw new Error("D1 compliance batch failed");
    for (const { sql, binds } of statements) {
      if (sql.includes("UPDATE")) openChecks.delete(String(binds[1]));
      else openChecks.add(String(binds[2]));
    }
    events.push("checks committed");
    return statements.map(() => ({ success: true }));
  },
};
fake("../../lib/cloudflare-runtime", { getReceiptsDb: () => db, getReceiptsProcessorKey: () => "processor" });
fake("../../lib/receipts/auth", { requireReceiptsActor: async () => {
  if (authFails) throw new Error("Unauthorized");
  return "human";
} });
fake("../../lib/receipts/files", { listFilesForObject: async () => [{ is_original: 1, content_type: "application/pdf" }] });
fake("../../lib/receipts/settings", { getComplianceSettings: async () => COMPLIANCE_DEFAULTS });
fake("../../lib/receipts/receipt-locks", { getReceiptLocks: async () => new Map([["r1", { locked }]]) });
fake("../../lib/receipts/audit", { createAuditEntry: async (_db: unknown, entry: { action: string }) => { actions.push(entry.action); } });
fake("../../lib/receipts/db", {
  getReceiptRecord: async () => receipt,
  reconcileExtractionState: async (_id: string, state: string) => { receipt.extraction_state = state as ReceiptRecord["extraction_state"]; },
  updateReceiptRecord: async (_id: string, input: UpdateReceiptInput) => {
    if (deferDate && input.transactionDate) throw new ExportFinalizedError("2026-06", "Month finalized");
    if (finishFails && input.extractionState === "processed") throw new Error("D1 completion write failed");
    updates.push(input);
    // Use the real sparse-update builder, including its automatic processed-state branch.
    const { sets, binds } = buildReceiptUpdateSets(input, receipt);
    sets.forEach((set, i) => { Object.assign(receipt, { [set.split(" = ")[0]]: set.includes("'processed'") ? "processed" : binds[i] }); });
    if (input.extractionState === "processed") events.push("processed committed");
  },
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require("../../app/api/receipts/[id]/extract/route") as {
  POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response>;
};
function reset(overrides: Partial<ReceiptRecord> = {}) {
  receipt = {
    id: "r1", status: "captured", extraction_state: "queued", extraction_attempts: 0,
    transaction_date: null, merchant: null, amount_minor: null, currency: "JPY",
    expense_category_code: "supplies", original_content_type: "application/pdf",
    ...overrides,
  } as ReceiptRecord;
  openChecks = new Set(["missing_transaction_date", "missing_amount", "missing_receipt"]);
  batchFails = finishFails = locked = authFails = deferDate = false;
  batchCount = 0; updates = []; actions = []; events = [];
}
function post(body: unknown = { rawText: "店舗\n2026年6月5日\n合計 1,000円\nT1234567890123" }, processor = true, query = "") {
  return POST(new Request(`http://localhost/api/receipts/r1/extract${query}`, {
    method: "POST", headers: processor ? { "x-receipts-processor-key": "processor" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { params: Promise.resolve({ id: "r1" }) });
}

test("processor extraction commits canonical checks before processed/completed without opening Review", async () => {
  reset();
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { ok: boolean }).ok, true);
  assert.equal(receipt.transaction_date, "2026-06-05");
  assert.equal(receipt.amount_minor, 1000);
  assert.deepEqual([...openChecks], []);
  assert.equal(updates[0].extractionState, "queued");
  assert.equal(receipt.extraction_state, "processed");
  assert.deepEqual(events, ["checks committed", "processed committed"]);
  assert.ok(actions.includes("receipt.extraction_completed"));
});

test("failed compliance batch preserves blockers and pending state; a bodyless human retry uses stored OCR", async () => {
  reset(); batchFails = true;
  const response = await post();
  assert.equal(response.status, 500);
  assert.match(((await response.json()) as { error: string }).error, /compliance refresh failed.*Retry/);
  assert.deepEqual([...openChecks], ["missing_transaction_date", "missing_amount", "missing_receipt"]);
  assert.equal(receipt.extraction_state, "queued");
  assert.equal(receipt.status, "needs_review");
  assert.ok(receipt.extraction_json);
  assert.ok(!actions.includes("receipt.extraction_completed"));
  batchFails = false;
  assert.equal((await post(null, false)).status, 200);
  assert.deepEqual([...openChecks], []);
  assert.equal(receipt.extraction_state, "processed");
  assert.equal(batchCount, 2);
});

test("human force reparse refreshes checks against persisted fields, preserving nonempty fields by default", async () => {
  reset({ merchant: "Operator merchant", amount_minor: 2000 });
  assert.equal((await post(undefined, false)).status, 200);
  assert.equal(receipt.merchant, "Operator merchant");
  assert.equal(receipt.amount_minor, 2000);
  assert.equal((await post({ rawText: "店舗\n2026年6月5日\n合計 3,000円\nT1234567890123" }, false, "?force=true")).status, 200);
  assert.equal(receipt.amount_minor, 3000);
});

test("deferred locked-month date checks the actual saved receipt, keeping its date blocker open", async () => {
  reset(); deferDate = true;
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { dateDeferred: boolean }).dateDeferred, true);
  assert.equal(receipt.transaction_date, null);
  assert.deepEqual([...openChecks], ["missing_transaction_date"]);
});

test("sealed, archived, deleted and reviewed receipts cannot have fields/checks overwritten, even with force", async () => {
  for (const overrides of [{}, { status: "archived" }, { status: "reviewed" }, { status: "reconciled" }, { status: "exported" }, { deleted_at: "2026-06-10" }]) {
    reset(overrides as Partial<ReceiptRecord>);
    locked = Object.keys(overrides).length === 0;
    assert.equal((await post(undefined, true, "?force=true")).status, 409);
    assert.equal(updates.length, 0);
    assert.equal(batchCount, 0);
    assert.equal(receipt.amount_minor, null);
  }
});

test("auth failure cannot mutate extraction/compliance", async () => {
  reset(); authFails = true;
  assert.equal((await post(undefined, false)).status, 401);
  assert.equal(updates.length, 0);
  assert.equal(batchCount, 0);
});


test("new canonical blockers persist, and failure of the final processed write remains retryable", async () => {
  reset({ expense_category_code: null }); finishFails = true;
  assert.equal((await post()).status, 500);
  assert.deepEqual([...openChecks], ["missing_category"]);
  assert.equal(receipt.extraction_state, "queued");
  assert.ok(!actions.includes("receipt.extraction_completed"));
  finishFails = false;
  assert.equal((await post()).status, 200);
  assert.equal(receipt.extraction_state, "processed");
  assert.equal(batchCount, 1, "unchanged check set does not insert duplicate open checks on retry");
});
