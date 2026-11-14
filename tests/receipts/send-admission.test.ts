// Actual Send route + composition + transport + transactional SQLite; only
// bindings, auth, pack preflight and provider network are mocked. No live sends.
import test, { mock, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

interface RawStmt {
  get(...p: unknown[]): Record<string, unknown> | undefined;
  all(...p: unknown[]): Record<string, unknown>[];
  run(...p: unknown[]): { changes: number | bigint };
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStmt;
}

function mkRawDb(): RawDb {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- no typings in this @types/node
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => RawDb };
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`db/receipts/${f}`, "utf8"));
  }
  return db;
}

class SqliteD1 {
  readonly db: RawDb = mkRawDb();
  /** Async hook before EVERY statement (reads included) — the pause point. */
  onBeforeStatement: ((sql: string) => Promise<void>) | null = null;
  /** Async hook AFTER a statement executed (its result already captured) —
   *  used to suspend a caller between its unlocked read and its next step. */
  onAfterStatement: ((sql: string) => Promise<void>) | null = null;
  /** When set, a statement matching this predicate throws BEFORE running. */
  injectFailure: ((sql: string) => Error | null) | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  prepare(sql: string) {
    // The bound form carries the args; the bare form (no .bind) runs with none
    // — some helpers call prepare(sql).all() directly.
    const make = (args: unknown[]) => {
      const spec = { sql, args } as { sql: string; args: unknown[] };
      return {
        first: async <T>(): Promise<T | null> => {
          await this.onBeforeStatement?.(sql);
          const row = (this.db.prepare(sql).get(...args) ?? null) as T | null;
          await this.onAfterStatement?.(sql);
          return row;
        },
        all: async <T>(): Promise<{ results: T[] }> => {
          await this.onBeforeStatement?.(sql);
          const rows = { results: this.db.prepare(sql).all(...args) as T[] };
          await this.onAfterStatement?.(sql);
          return rows;
        },
        run: async (): Promise<{ success: true; meta: { changes: number } }> => {
          await this.onBeforeStatement?.(sql);
          const injected = this.injectFailure?.(sql);
          if (injected) throw injected;
          const info = this.db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
        __spec: spec,
        bind: (...next: unknown[]) => make(next),
      };
    };
    return make([]);
  }
  batch(stmts: { __spec: { sql: string; args: unknown[] } }[]) {
    const run = this.chain.then(() => this.runBatch(stmts));
    this.chain = run.catch(() => undefined);
    return run;
  }
  private async runBatch(stmts: { __spec: { sql: string; args: unknown[] } }[]) {
    this.db.exec("BEGIN");
    try {
      const results: { success: true; meta: { changes: number } }[] = [];
      for (const s of stmts) {
        await this.onBeforeStatement?.(s.__spec.sql);
        const injected = this.injectFailure?.(s.__spec.sql);
        if (injected) throw injected;
        const info = this.db.prepare(s.__spec.sql).run(...s.__spec.args);
        results.push({ success: true, meta: { changes: Number(info.changes) } });
      }
      this.db.exec("COMMIT");
      return results;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}


const t0 = Date.parse("2026-11-14T00:00:00.000Z");
let d1: SqliteD1;
let bytes: Uint8Array;
let settings: Record<string, string | null>;
let from: string;
let calls: { key: string; payload: string }[];
let provider: () => Promise<Response>;
let prepareHook: (() => Promise<void>) | null = null;
let authenticated = true;
let hasObject = true;
const actualFetch = globalThis.fetch;
mock.module("@/lib/cloudflare-runtime", { namedExports: {
  getReceiptsDb: () => d1.asD1(),
  getReceiptsArchiveBucket: () => ({
    head: async () => hasObject ? ({ size: bytes.byteLength }) : null,
    get: async () => { await prepareHook?.(); return { body: bytes }; },
  }),
  getResendApiKeyOrNull: () => "mock-key", getDeliveryFromAddress: () => from,
  getAccountantEmail: () => "accountant@example.com",
}});
mock.module("@/lib/receipts/auth", { namedExports: {
  requireReceiptsActor: async () => { if (!authenticated) throw new Error("Unauthorized"); return "operator"; },
}});
mock.module("@/lib/receipts/settings", { namedExports: { getComplianceSettings: async () => settings } });
mock.module("@/lib/receipts/delivery-preflight", { namedExports: {
  runPreflightOnSealedZip: async () => ({ report: { passed: true, results: [] }, summary: null }),
}});
globalThis.fetch = (async (_url, init) => {
  calls.push({ key: new Headers(init?.headers).get("Idempotency-Key")!, payload: String(init?.body) });
  return provider();
}) as typeof fetch;
after(() => { globalThis.fetch = actualFetch; mock.timers.reset(); });
const loadRoute = () => import("@/app/api/receipts/export/[month]/send/route");
const loadDb = () => import("@/lib/receipts/db");
const compose = async () => (await import("@/lib/receipts/delivery-compose")).composeDelivery("2026-07");

function seed(id = "e1", revision = 1) {
  d1.db.prepare(`INSERT INTO receipt_exports
    (id, export_month, status, created_by, created_at, finalized_at, export_revision,
      proofs_r2_key, proofs_sha256, archive_r2_key, manifest_r2_key, bundle_build_id)
    VALUES (?, '2026-07', 'finalized', 'operator', ?, ?, ?, ?, 'sealed-sha', 'archive', 'manifest', ?)`)
    .run(id, new Date().toISOString(), new Date().toISOString(), revision, `${id}/proofs.zip`, `build-${id}`);
}
function fresh() {
  mock.timers.reset(); mock.timers.enable({ apis: ["Date"], now: t0 });
  d1 = new SqliteD1(); bytes = new Uint8Array([1, 2, 3]); from = "from@example.com";
  settings = { notification_recipient: "accountant@example.com", notification_cc_recipient: null,
    delivery_reply_to: null, delivery_signature: null };
  calls = []; prepareHook = null; authenticated = true; hasObject = true;
  provider = async () => Response.json({ id: "message" });
  seed();
}
async function send(body: unknown = {}, force = false) {
  return (await loadRoute()).POST(new Request(`http://localhost/api/receipts/export/2026-07/send${force ? "?force_new=true" : ""}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  }), { params: Promise.resolve({ month: "2026-07" }) });
}
function rows() { return d1.db.prepare("SELECT * FROM export_deliveries ORDER BY rowid").all(); }
function owner() { return d1.db.prepare("SELECT * FROM receipt_exports WHERE id='e1'").get()!; }
function review(c: Awaited<ReturnType<typeof compose>>) {
  return { compositionHash: c.compositionHash, observedGeneration: c.observedGeneration, observedAttemptId: c.observedAttemptId };
}
function barrier(match: (sql: string) => boolean) {
  let arrived = 0, release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  d1.onAfterStatement = async (sql) => { if (match(sql) && arrived < 2) { if (++arrived === 2) release(); await gate; } };
}

for (const scenario of ["initial", "definitive failure", "corrected revision", "pending resume", "ambiguous resume", "override"] as const) {
  test(`admission race: ${scenario} elects one route; no independent second key`, async () => {
    fresh();
    if (scenario === "definitive failure") { provider = async () => Response.json({ message: "invalid" }, { status: 422 }); await send(); }
    if (scenario === "corrected revision") { await send(); seed("e2", 2); }
    if (scenario === "pending resume" || scenario === "ambiguous resume") {
      provider = async () => { throw new Error("unknown acceptance"); }; await send();
      if (scenario === "pending resume") d1.db.prepare("UPDATE export_deliveries SET state='pending'").run();
    }
    if (scenario === "override") await send();
    const reviewed = review(await compose());
    provider = async () => Response.json({ id: "message" });
    const before = calls.length;
    barrier((sql) => sql.includes("SELECT d.*"));
    const results = await Promise.all([send(reviewed, scenario === "override"), send(reviewed, scenario === "override")]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(calls.length, before + 1);
    if (scenario.includes("resume")) assert.equal(new Set(calls.map((c) => c.key)).size, 1);
    if (scenario === "corrected revision") assert.equal(rows().at(-1)!.export_id, "e2");
    if (scenario === "override") assert.equal(d1.db.prepare("SELECT count(*) n FROM receipt_audit_log WHERE action='export.delivery_override'").get()!.n, 1);
  });
}

test("confirmed sent settles ambiguous retries and fresh override requires observed ownership", async () => {
  fresh(); provider = async () => { throw new Error("timeout"); }; await send();
  provider = async () => Response.json({ id: "accepted" }); await send();
  assert.equal((await send()).status, 409);
  assert.equal((await send({}, true)).status, 409);
  const first = review(await compose());
  assert.equal((await send(first, true)).status, 200);
  assert.equal((await send(first, true)).status, 409);
  assert.equal((await send(review(await compose()), true)).status, 200);
  assert.equal(new Set(calls.map((c) => c.key)).size, 3);
});

for (const hour of [0, 22.999, 23, 25]) {
  test(`fixed origin cutoff at ${hour} hours; retries never extend provider TTL`, async () => {
    fresh();
    const accepted = new Map<string, number>();
    let acceptances = 0;
    provider = async () => {
      const key = calls.at(-1)!.key, previous = accepted.get(key);
      if (previous === undefined || Date.now() - previous >= 24 * 3600000) { accepted.set(key, Date.now()); acceptances++; }
      throw new Error("response lost");
    };
    await send();
    mock.timers.tick(hour * 3600000);
    assert.equal((await send()).status, hour < 23 ? 200 : 409);
    mock.timers.tick(25 * 3600000);
    assert.equal((await send()).status, 409);
    assert.equal(acceptances, 1);
    assert.equal(new Set(calls.map((c) => c.key)).size, 1);
  });
}

test("preparation crossing cutoff refuses transport after durable resume admission", async () => {
  fresh(); provider = async () => { throw new Error("timeout"); }; await send();
  mock.timers.tick(23 * 3600000 - 1);
  prepareHook = async () => { mock.timers.tick(2); };
  assert.equal((await send()).status, 409);
  assert.equal(calls.length, 1);
});

for (const badTime of ["", "garbled", "2026-11-14", "2026-11-13T24:00:00.000Z", "2099-01-01T00:00:00Z"]) {
  test(`invalid first admission time ${JSON.stringify(badTime)} fails closed`, async () => {
    fresh(); provider = async () => { throw new Error("timeout"); }; await send();
    d1.db.prepare("UPDATE export_deliveries SET created_at=?").run(badTime);
    assert.equal((await send()).status, 409); assert.equal(calls.length, 1);
  });
}

for (const field of ["to", "cc", "from", "replyTo", "signature", "zip", "key", "filename", "html", "revision"] as const) {
  test(`frozen resume rejects reviewed ${field} drift and never changes payload under its old key`, async () => {
    fresh(); provider = async () => { throw new Error("timeout"); }; await send();
    if (field === "to") settings.notification_recipient = "new@example.com";
    if (field === "cc") settings.notification_cc_recipient = "new@example.com";
    if (field === "from") from = "other@example.com";
    if (field === "replyTo") settings.delivery_reply_to = "reply@example.com";
    if (field === "signature") settings.delivery_signature = "new signature";
    if (field === "zip") bytes = new Uint8Array([4, 5, 6, 7]);
    if (["key", "filename", "html"].includes(field)) {
      const payload = JSON.parse(String(rows()[0].payload_json));
      payload[field === "key" ? "proofsKey" : field === "filename" ? "zipFilename" : "html"] = "changed";
      d1.db.prepare("UPDATE export_deliveries SET payload_json=?").run(JSON.stringify(payload));
    }
    const oldReview = review(await compose());
    if (field === "revision") seed("e2", 2);
    assert.equal((await send(oldReview)).status, 409);
    assert.equal(calls.length, 1);
    if (field !== "revision") {
      assert.equal((await compose()).action, "blocked", "preview offers deliberate review instead of broken resume");
      assert.equal((await send(review(await compose()), true)).status, 200);
      assert.equal(new Set(calls.map((c) => c.key)).size, 2);
    }
  });
}

test("ordinary resumes transmit byte-identical provider envelope and key", async () => {
  fresh(); provider = async () => { throw new Error("unknown"); };
  await send(); await send();
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(rows()[1].payload_json, rows()[0].payload_json);
});

test("a revision published during pinned composition or just before admission cannot mix pack identities", async () => {
  for (const point of ["R2", "admission"]) {
    fresh();
    if (point === "R2") prepareHook = async () => { prepareHook = null; seed("e2", 2); };
    else {
      const batch = d1.batch.bind(d1);
      d1.batch = (statements) => {
        if (statements.some((s) => s.__spec.sql.includes("INSERT INTO export_deliveries"))) seed("e2", 2);
        return batch(statements);
      };
    }
    assert.equal((await send()).status, 409);
    assert.equal(rows().length, 0); assert.equal(calls.length, 0);
    assert.equal(d1.db.prepare("SELECT count(*) n FROM receipt_audit_log").get()!.n, 0);
  }
});

test("outcome generation fences a stale pending-resume decision after confirmed sent", async () => {
  fresh(); provider = async () => { throw new Error("unknown"); }; await send();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((r) => release = r), parked = new Promise<void>((r) => reached = r);
  prepareHook = async () => { prepareHook = null; reached(); await held; };
  const stale = send(); await parked;
  provider = async () => Response.json({ id: "sent" });
  assert.equal((await send()).status, 200);
  release(); assert.equal((await stale).status, 409);
  assert.equal(calls.length, 2); assert.equal(owner().delivery_state, "delivered");
});

test("same-attempt sent dominates delayed ambiguous completion; old-attempt results cannot regress new ownership or display", async () => {
  fresh();
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((r) => release = r), parked = new Promise<void>((r) => reached = r);
  provider = async () => { reached(); await held; throw new Error("late unknown"); };
  const first = send(); await parked;
  provider = async () => Response.json({ id: "sent" });
  await send(); release(); await first;
  assert.equal(owner().delivery_state, "delivered");
  assert.equal((await compose()).deliveryState, "delivered");
  assert.equal((await send()).status, 409);
  // A new explicitly confirmed send owns reporting even if older results land later.
  provider = async () => Response.json({ message: "invalid" }, { status: 422 });
  await send(review(await compose()), true);
  const current = owner().current_delivery_attempt_id;
  const db = await loadDb();
  await db.markDeliveryAmbiguous(String(rows()[0].id), "delayed", d1.asD1(), "operator");
  assert.equal(owner().current_delivery_attempt_id, current);
  assert.equal(owner().delivery_state, "sealed_undelivered");
  assert.equal((await compose()).deliveryState, "sealed_undelivered");
  const { finalizedMonthsDeliveryState } = await import("@/lib/receipts/delivery-status-core");
  const exports = await db.listExports(), deliveries = await db.listDeliveriesForMonth("2026-07");
  assert.equal(finalizedMonthsDeliveryState(exports, deliveries).get("2026-07"), "sealed_undelivered");
});

for (const code of ["concurrent_idempotent_requests", "invalid_idempotent_request"]) {
  test(`provider 409 ${code} retains uncertainty, code in audit and original key`, async () => {
    fresh(); provider = async () => Response.json({ name: code, message: "conflict" }, { status: 409 });
    assert.equal(((await (await send()).json()) as { classification: string }).classification, "ambiguous");
    await send();
    assert.equal(rows()[0].state, "ambiguous"); assert.deepEqual(calls[1], calls[0]);
    const audits = d1.db.prepare("SELECT new_value_json FROM receipt_audit_log WHERE action='export.delivery_failed'").all();
    assert.equal(JSON.parse(String(audits[0].new_value_json)).name, code);
  });
}

test("a definitive resume rejection cannot erase an earlier possible acceptance", async () => {
  fresh(); provider = async () => { throw new Error("accepted response lost"); }; await send();
  provider = async () => Response.json({ message: "invalid now" }, { status: 422 });
  await send(); await send();
  assert.equal(new Set(calls.map((c) => c.key)).size, 1);
  assert.equal((await compose()).action, "resume");
});

for (const failure of ["admission", "history", "override audit", "outcome audit", "admission ack", "outcome ack"]) {
  test(`transaction failure / unknown acknowledgement: ${failure} stays conservative`, async () => {
    fresh();
    if (failure === "override audit") await send();
    const reviewed = review(await compose()), before = rows().length;
    if (failure.endsWith("ack")) {
      const batch = d1.batch.bind(d1);
      d1.batch = async (statements) => {
        const result = await batch(statements);
        const isAdmission = statements.some((s) => s.__spec.sql.includes("INSERT INTO export_deliveries"));
        if (isAdmission === (failure === "admission ack")) throw new Error("database response lost after COMMIT");
        return result;
      };
    } else {
      d1.injectFailure = (sql) => {
        if (failure === "admission" && sql.includes("SET delivery_generation")) return new Error("failed CAS write");
        if (failure === "history" && sql.includes("INSERT INTO export_deliveries")) return new Error("failed history insert");
        // SQL action binds are opaque here; admission audit is VALUES, outcome audit SELECT.
        if (failure === "override audit" && sql.includes("VALUES (?, ?, ?, 'export'")) return new Error("failed override audit");
        if (failure === "outcome audit" && sql.includes("SELECT ?, ?, ?, 'export'")) return new Error("failed outcome audit");
        return null;
      };
    }
    const result = await send(reviewed, failure === "override audit");
    assert.equal(result.status, 500);
    assert.match(((await result.json()) as { error: string }).error, /unknown|not confirmed/);
    if (["admission", "history", "override audit"].includes(failure)) {
      assert.equal(rows().length, before);
      assert.equal(calls.length, before);
      assert.equal(owner().delivery_generation, failure === "override audit" ? 2 : 0);
    } else if (failure === "admission ack") {
      assert.equal(calls.length, 0); assert.equal(rows()[0].state, "pending");
    } else {
      assert.equal(calls.length, 1);
      assert.equal(rows()[0].state, failure === "outcome ack" ? "sent" : "pending");
    }
    // Restore failures and prove the next ordinary HTTP request never mints an unsafe key.
    d1.injectFailure = null;
    if (failure.endsWith("ack")) d1.batch = SqliteD1.prototype.batch.bind(d1);
    const priorKey = calls[0]?.key;
    await send();
    if (priorKey && failure !== "override audit") assert.equal(new Set(calls.map((c) => c.key)).size, 1);
  });
}

for (const legacyState of ["sent", "pending", "ambiguous", "failed"] as const) {
  test(`legacy ${legacyState} preserves history and requires honest admission`, async () => {
    fresh();
    d1.db.prepare(`INSERT INTO export_deliveries
      (id,export_id,attempt_id,idempotency_key,state,to_address,subject,body,zip_filename,zip_sha256,zip_bytes,created_at)
      VALUES ('legacy','e1','legacy-attempt','legacy-key',?,'old@example.com','s','b','z.zip','hash',3,?)`).run(legacyState, new Date().toISOString());
    d1.db.prepare("UPDATE receipt_exports SET current_delivery_attempt_id='legacy-attempt'").run();
    assert.equal((await send()).status, legacyState === "failed" ? 200 : 409);
    assert.equal(rows()[0].state, legacyState);
    if (legacyState !== "failed") {
      assert.equal(calls.length, 0);
      assert.equal((await send(review(await compose()), true)).status, 200);
    }
  });
}

test("Send versus deletion: admission winner blocks deletion; deleted export makes stale Send lose atomically", async () => {
  const { executeExportDeletion } = await import("@/lib/receipts/export-deletion");
  for (const sendWins of [true, false]) {
    fresh();
    const plan = { exportId: "e1", month: "2026-07", plannedStatus: "finalized" as const,
      actor: "operator", nowIso: new Date().toISOString(), auditId: "delete", assertId: "assert-delete",
      auditValueJson: "{}", plannedIdentity: { bundleBuildId: "build-e1", archiveKey: "archive", manifestKey: "manifest", proofsKey: "e1/proofs.zip" } };
    if (sendWins) {
      await send(); await assert.rejects(executeExportDeletion(d1.asD1(), plan));
      assert.equal(rows().length, 1); assert.ok(owner());
    } else {
      prepareHook = async () => { prepareHook = null; await executeExportDeletion(d1.asD1(), plan); };
      assert.equal((await send()).status, 409);
      assert.equal(calls.length, 0); assert.equal(rows().length, 0); assert.equal(owner(), undefined);
    }
  }
});

test("fresh/upgrade migration preserves legacy ZIP identities/history; equal timestamps use ownership, never UUID order", async () => {
  fresh();
  // Reconstruct the pre-upgrade database with all 43 shipped migrations.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => RawDb };
  const old = new DatabaseSync(":memory:"); old.exec("PRAGMA foreign_keys=ON");
  const files = readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => !f.startsWith("0044"))) old.exec(readFileSync(`db/receipts/${f}`, "utf8"));
  old.exec(`INSERT INTO receipt_exports (id,export_month,status,created_by,created_at,proofs_r2_key)
    VALUES ('legacy-export','2026-07','finalized','op','time','immutable/zip');
    INSERT INTO export_deliveries (id,export_id,attempt_id,idempotency_key,state,to_address,subject,body,zip_filename,zip_sha256,zip_bytes,created_at)
    VALUES ('z','legacy-export','z-attempt','z-key','sent','to','s','b','z.zip','sha',3,'2026-07-01'),
    ('a','legacy-export','a-attempt','a-key','failed','to','s','b','z.zip','sha',3,'2026-07-01');`);
  const before = old.prepare("SELECT * FROM export_deliveries ORDER BY rowid").all();
  old.exec(readFileSync("db/receipts/0044_delivery_admission.sql", "utf8"));
  assert.equal(old.prepare("SELECT proofs_r2_key FROM receipt_exports").get()!.proofs_r2_key, "immutable/zip");
  assert.equal(old.prepare("SELECT current_delivery_attempt_id FROM receipt_exports").get()!.current_delivery_attempt_id, "a-attempt");
  const after = old.prepare("SELECT * FROM export_deliveries ORDER BY rowid").all();
  after.forEach((r, i) => { const { payload_json, admission_generation, ...original } = r;
    assert.equal(payload_json, null); assert.equal(admission_generation, null); assert.deepEqual(original, { ...before[i] }); });
  assert.deepEqual(old.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(d1.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Clerk auth stays required; delivered preview drives the header contract", async () => {
  fresh(); authenticated = false; assert.equal((await send()).status, 401); assert.equal(calls.length, 0);
  authenticated = true; await send();
  const composed = await compose(); assert.equal(composed.deliveryState, "delivered"); assert.equal(composed.action, "blocked");
  const ui = readFileSync("components/receipts/export/delivery-composer.tsx", "utf8");
  assert.match(ui, /composed.deliveryState === "delivered"/);
  assert.match(ui, /observedGeneration: composed.observedGeneration/);
});

for (const lateResult of ["sent", "ambiguous"] as const) {
  test(`older logical attempt's delayed ${lateResult} stays historical after reviewed new attempt settles`, async () => {
    fresh();
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((r) => release = r), parked = new Promise<void>((r) => reached = r);
    provider = async () => { reached(); await held;
      if (lateResult === "ambiguous") throw new Error("late timeout");
      return Response.json({ id: "old accepted" });
    };
    const old = send(); await parked;
    provider = async () => Response.json({ id: "new accepted" });
    const preview = await compose();
    assert.equal((await send(review(preview), true)).status, 200);
    const current = owner().current_delivery_attempt_id;
    release(); await old;
    assert.equal(owner().current_delivery_attempt_id, current);
    assert.equal(owner().delivery_state, "delivered");
    assert.equal((await compose()).deliveryState, "delivered");
    assert.equal(rows()[0].state, lateResult);
    assert.equal(new Set(calls.map((c) => c.key)).size, 2);
  });
}

test("rendered composer header agrees with logical delivered/current failed status (including missing bytes)", async () => {
  fresh(); await send();
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { DeliveryComposer } = await import("@/components/receipts/export/delivery-composer");
  const render = async () => renderToStaticMarkup(createElement(DeliveryComposer, { composed: await compose(), monthLabel: "July 2026" }));
  const delivered = await render();
  assert.match(delivered, /送信済み · レポート用のクローズ処理は完了しています。/);
  assert.doesNotMatch(delivered, /まだ送信されていません/);
  hasObject = false;
  assert.match(await render(), /送信済み · レポート用のクローズ処理は完了しています。/);
  hasObject = true;
  provider = async () => Response.json({ message: "rejected" }, { status: 422 });
  await send(review(await compose()), true);
  const failed = await render();
  assert.match(failed, /前回の送信は未完了です/);
  assert.doesNotMatch(failed, /クローズ処理も完了しています/);
});

test("a reviewed override's uncertain response resumes its CURRENT key despite older success; never resurrect older keys", async () => {
  fresh(); await send();
  provider = async () => { throw new Error("override response lost"); };
  await send(review(await compose()), true);
  const currentKey = calls.at(-1)!.key;
  assert.equal((await compose()).action, "resume");
  await send(); assert.equal(calls.at(-1)!.key, currentKey);
  assert.equal(new Set(calls.map((c) => c.key)).size, 2);
  // If an explicitly reviewed replacement was definitively rejected, its
  // predecessor's old uncertain key is historical, never resumed instead.
  fresh(); provider = async () => { throw new Error("old unknown"); }; await send();
  provider = async () => Response.json({ message: "rejected" }, { status: 422 });
  await send(review(await compose()), true);
  const replaced = owner().current_delivery_attempt_id;
  provider = async () => Response.json({ id: "fresh retry" });
  await send();
  assert.notEqual(owner().current_delivery_attempt_id, replaced);
  assert.equal(new Set(calls.map((c) => c.key)).size, 3);
});

test("retry rows cannot hide a malformed first durable admission or move its origin", async () => {
  fresh(); provider = async () => { throw new Error("unknown"); }; await send();
  mock.timers.tick(1 * 3600000); await send();
  d1.db.prepare("UPDATE export_deliveries SET created_at='malformed' WHERE admission_generation=1").run();
  assert.equal((await send()).status, 409); assert.equal(calls.length, 2);
});

test("provider name and code both survive; idempotency code makes even other 4xx uncertain", async () => {
  fresh(); provider = async () => Response.json({ name: "validation_error", code: "invalid_idempotent_request", message: "conflict" }, { status: 422 });
  await send(); await send();
  assert.equal(rows()[0].state, "ambiguous"); assert.equal(calls[0].key, calls[1].key);
  const audit = d1.db.prepare("SELECT new_value_json FROM receipt_audit_log WHERE action='export.delivery_failed' ORDER BY rowid LIMIT 1").get()!;
  const value = JSON.parse(String(audit.new_value_json));
  assert.equal(value.name, "validation_error"); assert.equal(value.code, "invalid_idempotent_request");
});
