import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error node:sqlite is available in the required Node22 runtime.
import { DatabaseSync } from "node:sqlite";
import { NextResponse as RealNextResponse } from "next/server";
import { recordExtractionFailure } from "@/lib/receipts/extraction-failure";

// Actual handler + actual SQL, including every shipped migration/trigger and FK.
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(`db/receipts/${file}`, "utf8"));
  }
  sqlite.exec(`INSERT INTO receipt_records
    (id,captured_at,captured_by,payment_path,status,original_r2_key,original_sha256,
     original_content_type,original_size_bytes,created_at,updated_at,extraction_state)
    VALUES ('r1','t','a','CASH','captured','k','sha','image/jpeg',1,'t','t','queued')`);
  let beforeBatch: (() => void) | null = null;
  let beforeRun: (() => void) | null = null;
  let loseResponse = false;
  let uncertainResult = false;
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      sql, args,
      first: async <T>(): Promise<T | null> => sqlite.prepare(sql).get(...args) as T ?? null,
      run: async () => {
        const hook = beforeRun; beforeRun = null; hook?.();
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
    }),
  });
  const adapter = {
    prepare,
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      const hook = beforeBatch; beforeBatch = null; hook?.();
      sqlite.exec("BEGIN");
      const results = [];
      try {
        for (const stmt of stmts) {
          const info = sqlite.prepare(stmt.sql).run(...stmt.args);
          results.push({ success: true, meta: { changes: Number(info.changes) } });
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      if (loseResponse) throw new Error("injected lost batch acknowledgement after commit");
      return uncertainResult ? [] : results;
    },
  };
  return {
    sqlite,
    db: adapter as unknown as D1Database,
    row: () => sqlite.prepare("SELECT * FROM receipt_records WHERE id='r1'").get() as {
      extraction_state: string | null; extraction_json: string | null;
      extraction_processed_at: string | null; updated_at: string;
    },
    audits: () => sqlite.prepare("SELECT * FROM receipt_audit_log").all() as {
      actor: string; action: string; new_value_json: string;
    }[],
    change: (sql: string) => sqlite.exec(`UPDATE receipt_records SET ${sql} WHERE id='r1'`),
    beforeBatch: (hook: () => void) => { beforeBatch = hook; },
    beforeRun: (hook: () => void) => { beforeRun = hook; },
    loseResponse: () => { loseResponse = true; },
    uncertainResult: () => { uncertainResult = true; },
  };
}
let current: ReturnType<typeof fixture>;
let unauthorized = false;
let authCalls = 0;
let breakResponse = false;
mock.module("@/lib/cloudflare-runtime", { namedExports: {
  getReceiptsDb: () => current.db,
  getReceiptsProcessorKey: () => "processor-test",
} });
mock.module("@/lib/receipts/auth", { namedExports: {
  requireReceiptsActor: async () => {
    authCalls++;
    if (unauthorized) throw new Error("Unauthorized receipts request");
    return "human@test";
  },
} });
mock.module("next/server", { namedExports: { NextResponse: {
  json(body: unknown, init?: ResponseInit) {
    if (breakResponse && (init?.status ?? 200) === 200) {
      breakResponse = false;
      throw new Error("injected response failure after commit");
    }
    return RealNextResponse.json(body, init);
  },
} } });

async function post(body: unknown = { reason: "first", model: " mlx:test " }, key = "processor-test", raw = false) {
  const { POST } = await import("@/app/api/receipts/[id]/extraction-failed/route");
  const res = await POST(new Request("https://local/api/receipts/r1/extraction-failed", {
    method: "POST", headers: { "x-receipts-processor-key": key },
    body: raw ? String(body) : JSON.stringify(body),
  }), { params: Promise.resolve({ id: "r1" }) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
test.beforeEach(() => { current = fixture(); unauthorized = false; authCalls = 0; breakResponse = false; });
test.afterEach(() => current.sqlite.close());

for (const state of ["captured", "queued", "processing"]) {
  test(`handler: pending ${state} admits state + reason + winning audit atomically`, async () => {
    current.sqlite.prepare("UPDATE receipt_records SET extraction_state=?").run(state);
    const res = await post();
    assert.equal(res.status, 200);
    assert.equal(res.body.extractionState, "failed");
    const row = current.row();
    const data = JSON.parse(row.extraction_json!);
    assert.equal(data.reason, "first");
    assert.equal(data.model, "mlx:test");
    assert.equal(data.failed, true);
    assert.equal(data.failedAt, row.extraction_processed_at);
    assert.equal(data.failedAt, row.updated_at);
    assert.equal(current.audits().length, 1);
    assert.equal(current.audits()[0].actor, "mlx-consumer@mac");
    assert.equal(current.audits()[0].action, "receipt.extraction_failed");
    assert.deepEqual(JSON.parse(current.audits()[0].new_value_json), { failureReason: "first", model: "mlx:test" });
    assert.equal(authCalls, 0);
  });
}
test("handler: needs_review admits extraction failure", async () => {
  current.change("status='needs_review'");
  assert.equal((await post()).status, 200);
});
test("handler: repeat different reason/model preserves first marker, timestamp, all JSON and one audit", async () => {
  await post();
  const before = current.row();
  const res = await post({ reason: "second", model: "other" });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyRecorded, true);
  assert.equal(res.body.reason, "first");
  assert.equal(res.body.failedAt, before.extraction_processed_at);
  assert.deepEqual(current.row(), before);
  assert.equal(current.audits().length, 1);
});
test("helper: simultaneous same-timestamp reports preserve only first reason and winning audit", async () => {
  const input = { db: current.db, receiptId: "r1", actor: "mlx", model: null, now: "same" };
  const results = await Promise.all([
    recordExtractionFailure({ ...input, reason: "winner" }),
    recordExtractionFailure({ ...input, reason: "loser" }),
  ]);
  assert.deepEqual(results.map((r) => r.kind), ["recorded", "already_terminal"]);
  assert.equal(JSON.parse(current.row().extraction_json!).reason, "winner");
  assert.equal(current.audits().length, 1);
  assert.equal(JSON.parse(current.audits()[0].new_value_json).failureReason, "winner");
});
test("handler: JSON change immediately before transaction survives (no read-snapshot overwrite)", async () => {
  current.change(`extraction_json='{"old":1}'`);
  current.beforeBatch(() => current.change(`extraction_json='{"old":1,"concurrent":{"keep":true}}'`));
  assert.equal((await post()).status, 200);
  assert.deepEqual(JSON.parse(current.row().extraction_json!), {
    old: 1, concurrent: { keep: true }, failed: true, reason: "first", model: "mlx:test",
    failedAt: current.row().extraction_processed_at,
  });
});
for (const json of [null, "bad json", "null", "[]", '"scalar"']) {
  test(`handler: legacy JSON ${json} still stores an object diagnostic`, async () => {
    current.sqlite.prepare("UPDATE receipt_records SET extraction_json=?").run(json);
    assert.equal((await post()).status, 200);
    assert.equal(JSON.parse(current.row().extraction_json!).reason, "first");
  });
}
for (const change of ["extraction_state='processed'", "extraction_state='failed',extraction_json='{" + '"reason":"earlier","failedAt":"then"' + "}'"]) {
  test(`handler: competing terminal commit ${change} is reported honestly`, async () => {
    current.beforeBatch(() => current.change(change));
    const res = await post();
    assert.equal(res.status, 200);
    assert.equal(res.body.extractionState, current.row().extraction_state);
    if (res.body.extractionState === "failed") {
      assert.equal(res.body.reason, "earlier");
      assert.equal(res.body.failedAt, "then");
    } else assert.equal(res.body.alreadyHandled, true);
    assert.equal(current.audits().length, 0);
  });
}
for (const status of ["reviewed", "reconciled", "exported", "archived"]) {
  for (const raced of [false, true]) {
    test(`handler: ${raced ? "raced" : "initial"} human ${status} heals pending state without failed JSON/audit`, async () => {
      if (raced) current.beforeBatch(() => current.change(`status='${status}'`));
      else current.change(`status='${status}'`);
      const res = await post();
      assert.equal(res.status, 200);
      assert.equal(res.body.extractionState, "processed");
      assert.equal(current.row().extraction_state, "processed");
      assert.equal(current.row().extraction_json, null);
      assert.equal(current.audits().length, 0);
    });
  }
}
test("handler: human status never overwrites committed failed reason", async () => {
  await post();
  current.change("status='reviewed'");
  const before = current.row();
  assert.equal((await post({ reason: "late" })).body.extractionState, "failed");
  assert.deepEqual(current.row(), before);
  assert.equal(current.audits().length, 1);
});
for (const change of ["needs_render=1", "needs_render=1,status='reviewed'", "needs_render=1,extraction_state='failed'", "deleted_at='gone'", "status='reviewed',deleted_at='gone'"]) {
  for (const raced of [false, true]) {
    test(`handler: ${raced ? "raced" : "initial"} gate ${change} refuses without mutation/audit`, async () => {
      if (raced) current.beforeBatch(() => current.change(change)); else current.change(change);
      const res = await post();
      assert.equal(res.status, change.includes("deleted_at") ? 404 : 409);
      assert.equal(current.row().extraction_state, change.includes("extraction_state") ? "failed" : "queued");
      assert.equal(current.row().extraction_json, null);
      assert.equal(current.audits().length, 0);
    });
  }
}
test("handler: missing receipt returns definitive not-found without success audit", async () => {
  current.sqlite.exec("DELETE FROM receipt_records");
  assert.deepEqual(await post(), { status: 404, body: { outcome: "not_found", error: "Receipt not found." } });
  assert.equal(current.audits().length, 0);
});
for (const [change, expected] of [
  ["needs_render=1", 409], ["deleted_at='gone'", 404],
  ["status='captured'", 409], ["extraction_state='processed'", 200],
  ["extraction_state='failed',extraction_json='{\"reason\":\"winner\"}'", 200],
] as const) {
  test(`handler: healing rechecks concurrent ${change} and rereads actual outcome`, async () => {
    current.change("status='reviewed'");
    current.beforeRun(() => current.change(change));
    const res = await post();
    assert.equal(res.status, expected);
    assert.equal(current.row().extraction_state,
      change.includes("extraction_state='processed'") ? "processed" :
      change.includes("extraction_state='failed'") ? "failed" : "queued");
    if (change.includes("extraction_state='failed'")) assert.equal(res.body.reason, "winner");
    assert.equal(current.audits().length, 0);
  });
}
test("handler: hard deletion racing the transaction returns actual not-found", async () => {
  current.beforeBatch(() => current.sqlite.exec("DELETE FROM receipt_records"));
  assert.equal((await post()).status, 404);
  assert.equal(current.audits().length, 0);
});
for (const body of [null, [], 4, true, "reason", {}, { reason: 4 }, { reason: [] }, { reason: {} }, { reason: true }, { reason: " " }, { reason: "x", model: 1 }, { reason: "x", model: [] }, { reason: "x", model: {} }, { reason: "x", model: false }]) {
  test(`handler: malformed boundary ${JSON.stringify(body)} returns 400 with no writes`, async () => {
    const before = current.row();
    assert.equal((await post(body)).status, 400);
    assert.deepEqual(current.row(), before);
    assert.equal(current.audits().length, 0);
  });
}
test("handler: invalid JSON is 400; long reason 413; length 1000 and nullable model accepted", async () => {
  assert.equal((await post("{bad", "processor-test", true)).status, 400);
  assert.equal((await post({ reason: "x".repeat(1001) })).status, 413);
  assert.equal((await post({ reason: "x".repeat(1000), model: null })).status, 200);
});
test("handler: human auth fallback and unauthorized processor preserve auth boundary", async () => {
  unauthorized = true;
  assert.equal((await post({ reason: "x" }, "bad")).status, 401);
  assert.equal(current.row().extraction_state, "queued");
  unauthorized = false;
  assert.equal((await post({ reason: "x" }, "bad")).status, 200);
  assert.equal(current.audits()[0].actor, "human@test");
});
for (const fault of ["update", "audit", "lost_ack", "unknown_result", "response"]) {
  test(`handler: ${fault} failure gives generic check-state guidance with accurate transaction outcome`, async () => {
    const before = current.row();
    if (fault === "update") current.sqlite.exec("CREATE TRIGGER break_write BEFORE UPDATE ON receipt_records BEGIN SELECT RAISE(ABORT,'private SQL failure'); END");
    if (fault === "audit") current.sqlite.exec("CREATE TRIGGER break_audit BEFORE INSERT ON receipt_audit_log BEGIN SELECT RAISE(ABORT,'private audit failure'); END");
    if (fault === "lost_ack") current.loseResponse();
    if (fault === "unknown_result") current.uncertainResult();
    if (fault === "response") breakResponse = true;
    const res = await post();
    assert.equal(res.status, 500);
    assert.match(String(res.body.error), /unconfirmed.*check.*current state/i);
    assert.doesNotMatch(String(res.body.error), /not modified|rollback|private|injected|SQL/i);
    if (fault === "update" || fault === "audit") {
      assert.deepEqual(current.row(), before);
      assert.equal(current.audits().length, 0);
    } else {
      assert.equal(current.row().extraction_state, "failed");
      assert.equal(JSON.parse(current.row().extraction_json!).reason, "first");
      assert.equal(current.audits().length, 1);
    }
  });
}
