import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { CLEANUP_CRON, DIGEST_CRON } from "../../../lib/receipts/pipeline-digest";
import { expectedStatementMonths } from "../../../lib/receipts/missing-statements";

const NOW = Date.parse("2026-11-11T23:30:00Z");
type Env = Parameters<typeof worker.scheduled>[1];
function context() {
  const tasks: Promise<unknown>[] = [];
  return { tasks, ctx: { waitUntil(p: Promise<unknown>) { tasks.push(p); } } as ExecutionContext };
}
function controller(cron: string) { return { cron, scheduledTime: NOW } as ScheduledController; }
function fixture() {
  const queries: string[] = []; const deleted: string[] = []; const updates: unknown[][] = [];
  const env = {
    DIGEST_ENABLED: "true", DIGEST_TO: "operator@example.com", RESEND_API_KEY: "fake-test-key", NOTIFY_FROM_ADDRESS: "receipts@example.com",
    RECEIPTS_DB: { prepare(sql: string) {
      queries.push(sql); let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) { args = values; return stmt; },
        async first() { return { n: 0, oldest_at: null }; },
        async all() {
          return { success: true, results: sql.includes("FROM email_receipt_intake") ? [
            { id: "pending", attachment_r2_key: "pending-key", status: "pending_triage", reject_reason: null },
            { id: "rejected", attachment_r2_key: "rejected-key", status: "rejected", reject_reason: "blocked_sender" },
          ] : sql.includes("amex_statement_artifacts") ? expectedStatementMonths(new Date(NOW)).map((m) => ({ statement_month: m.statementMonth })) : [] };
        },
        async run() { updates.push(args); return { success: true }; },
      };
      return stmt;
    } },
    RECEIPTS_BUCKET: { async delete(key: string) { deleted.push(key); } },
  } as unknown as Env;
  return { env, queries, deleted, updates };
}

test("cleanup alone deletes stale objects and preserves rejection reasons and audit rows", async (t) => {
  t.mock.method(console, "log", () => {});
  const f = fixture(); const c = context();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("cleanup must not email"); });
  await worker.scheduled(controller(CLEANUP_CRON), f.env, c.ctx);
  assert.equal(c.tasks.length, 1); await Promise.all(c.tasks);
  assert.deepEqual(f.deleted, ["pending-key", "rejected-key"]);
  assert.deepEqual(f.updates, [["attachment expired — R2 object deleted after 30 days pending", "pending"], ["blocked_sender", "rejected"]]);
  assert.match(f.queries[0], /status = 'rejected'[\s\S]*status = 'pending_triage' AND received_at < \?/);
  assert.equal(f.queries.length, 3); assert.ok(f.queries.slice(1).every((sql) => /UPDATE email_receipt_intake/.test(sql)));
});

test("digest waits for one mocked send, uses scheduled JST date, never invokes cleanup", async (t) => {
  t.mock.method(console, "log", () => {});
  const f = fixture(); const c = context(); let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++; assert.match(JSON.parse(String(init.body)).subject, /ALL CLEAR.*2026-11-12 JST/);
    return Response.json({ id: "mock" });
  });
  await worker.scheduled(controller(DIGEST_CRON), f.env, c.ctx);
  assert.equal(c.tasks.length, 1); await Promise.all(c.tasks);
  assert.equal(calls, 1); assert.deepEqual(f.deleted, []);
  assert.ok(f.queries.every((sql) => /^\s*SELECT/.test(sql) && !sql.includes("email_receipt_intake")));
});

test("disabled cron logs missing recipient and never queries or sends", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const f = fixture(); const c = context(); f.env.DIGEST_ENABLED = "false"; delete f.env.DIGEST_TO;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("disabled must not send"); });
  await worker.scheduled(controller(DIGEST_CRON), f.env, c.ctx); await Promise.all(c.tasks);
  assert.deepEqual(f.queries, []);
  assert.match(String(logs.mock.calls[0].arguments[0]), /disabled.*DIGEST_TO unset/);
});

test("misconfiguration and provider failure reject cron, with no false acceptance or raw error log", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  for (const mode of ["missing-provider", "send-failed"] as const) {
    const f = fixture(); const c = context(); if (mode === "missing-provider") delete f.env.RESEND_API_KEY;
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ message: "SECRET" }, { status: 503 }));
    await worker.scheduled(controller(DIGEST_CRON), f.env, c.ctx);
    await assert.rejects(Promise.all(c.tasks), /digest incomplete/);
    if (mode === "missing-provider") assert.equal(mock.mock.callCount(), 0);
    mock.mock.restore();
  }
  assert.doesNotMatch(JSON.stringify(logs.mock.calls), /SECRET|accepted/);
});

test("query failure emails truthful unavailable data but marks scheduled work failed", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture(); const c = context();
  f.env.RECEIPTS_DB = { prepare() { throw new Error("SECRET"); } } as unknown as D1Database;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++; assert.match(JSON.parse(String(init.body)).subject, /DATA UNAVAILABLE/);
    return Response.json({ id: "mock" });
  });
  await worker.scheduled(controller(DIGEST_CRON), f.env, c.ctx);
  await assert.rejects(Promise.all(c.tasks), /digest incomplete/); assert.equal(calls, 1);
});

test("unknown cron rejects explicitly with no email, cleanup, or background task", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture(); const c = context();
  await assert.rejects(worker.scheduled(controller("* * * * *"), f.env, c.ctx), /Unknown receipts intake cron/);
  assert.equal(c.tasks.length, 0); assert.deepEqual(f.queries, []); assert.deepEqual(f.deleted, []);
});

test("config prepares 08:30 JST and preserves original cleanup; recipient unset and sending disabled", () => {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""));
  assert.deepEqual(config.triggers.crons, [CLEANUP_CRON, DIGEST_CRON]);
  assert.equal(DIGEST_CRON, "30 23 * * *");
  assert.equal(config.vars.DIGEST_ENABLED, "false"); assert.equal(config.vars.DIGEST_TO, undefined);
  assert.equal(config.vars.ACCOUNTANT_EMAIL, undefined);
  assert.equal(config.observability.enabled, true);
});
