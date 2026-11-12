import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  loadDigestSnapshot, composePipelineDigest, runPipelineDigest, digestDate,
  digestIdempotencyKey, safeDigestFailureReason, DIGEST_DETAIL_CAP,
  type DigestSnapshot,
} from "../../lib/receipts/pipeline-digest";
import { expectedStatementMonths } from "../../lib/receipts/missing-statements";
import { finalizedMonthsDeliveryState } from "../../lib/receipts/delivery-status-core";

// The installed @types/node predates node:sqlite. Match the existing persistence tests.
interface Statement {
  all(...args: unknown[]): Record<string, unknown>[];
  get(...args: unknown[]): Record<string, unknown> | undefined;
  run(...args: unknown[]): unknown;
}
interface Sqlite { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => Sqlite };
const NOW = Date.parse("2026-11-11T23:30:00.000Z");
const OLD = "2026-11-09T00:00:00.000Z";
const config = { DIGEST_ENABLED: "true", DIGEST_TO: "operator@example.com", NOTIFY_FROM_ADDRESS: "receipts@example.com", RESEND_API_KEY: "fake-test-only" };

class Fixture {
  sqlite = new DatabaseSync(":memory:");
  failSql: RegExp | null = null;
  missingAggregate = false;
  missingResults = false;
  unsuccessful = false;
  emptyDetails = false;
  constructor() {
    const dir = new URL("../../db/receipts/", import.meta.url);
    for (const file of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
    }
  }
  db = { prepare: (sql: string) => {
    if (this.failSql?.test(sql)) throw new Error("D1 failure with secret that must not escape");
    const stmt = this.sqlite.prepare(sql);
    let args: unknown[] = [];
    const prepared = {
      bind: (...bindings: unknown[]) => { args = bindings; return prepared; },
      first: async () => this.missingAggregate ? null : stmt.get(...args) ?? null,
      all: async () => ({ success: !this.unsuccessful, results: this.missingResults ? undefined : this.emptyDetails && sql.includes("SELECT id, original_filename") ? [] : stmt.all(...args) }),
    };
    return prepared;
  } } as unknown as D1Database;
  statements() {
    for (const m of expectedStatementMonths(new Date(NOW))) this.artifact(m.statementMonth, "parsed");
  }
  artifact(month: string, status: string) {
    // Populate required columns directly from the migrated schema, then override.
    this.insert("amex_statement_artifacts", { id: `${month}-${status}`, statement_month: month, import_status: status, sha256_hash: `${month}-${status}`, r2_key: `${month}-${status}` });
  }
  insert(table: string, values: Record<string, string | number | null>) {
    const columns = this.sqlite.prepare(`PRAGMA table_info(${table})`).all();
    for (const col of columns) {
      if (col.notnull && col.dflt_value === null && !(String(col.name) in values)) {
        values[String(col.name)] = String(col.type).includes("INT") ? 0 : "fixture";
      }
    }
    const names = Object.keys(values);
    this.sqlite.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...Object.values(values));
  }
  receipt(id: string, state = "processed", extra: Record<string, string | number | null> = {}) {
    this.insert("receipt_records", { id, original_r2_key: `receipts/${id}`, captured_at: OLD,
      extraction_state: state, original_filename: `${id}.pdf`, ...extra });
    this.insert("receipt_files", { id: `manifest-${id}`, object_type: "receipt", object_id: id, r2_key: `receipts/${id}` });
  }
  export(id: string, month: string, rev = 1, status = "finalized", created = OLD) {
    this.insert("receipt_exports", { id, export_month: month, export_revision: rev, status, created_at: created });
  }
  delivery(id: string, exportId: string, state: string, created = OLD, attempt = id) {
    this.insert("export_deliveries", { id, export_id: exportId, attempt_id: attempt, state, created_at: created });
  }
}

function fixture(t: { after: (fn: () => void) => void }) {
  const f = new Fixture(); t.after(() => f.sqlite.close()); return f;
}

test("healthy migrated database earns a daily all-clear plain-text heartbeat", async (t) => {
  const f = fixture(t); f.statements(); f.receipt("healthy");
  f.export("sent", "2026-09"); f.delivery("sent-attempt", "sent", "sent");
  const snapshot = await loadDigestSnapshot(f.db, NOW);
  const message = composePipelineDigest(snapshot, NOW);
  assert.match(message.subject, /ALL CLEAR.*2026-11-12 JST/);
  assert.equal(message.unavailable, false);
  assert.match(message.text, /All checks completed/);
  assert.match(message.text, /not an independently monitored outage/);
});

test("all six health classes reuse SQL authority, errors first, counts/oldest/capped filenames/links", async (t) => {
  const f = fixture(t); f.statements();
  for (let i = 0; i < 7; i++) f.receipt(`never-${i}`, "captured", { captured_at: `2026-11-0${i + 1}T00:00:00.000Z` });
  f.receipt("queued", "queued", { extraction_enqueued_at: OLD });
  f.receipt("render", "captured", { needs_render: 1 });
  f.receipt("render-failed", "failed", { needs_render: 1, extraction_processed_at: OLD, extraction_json: JSON.stringify({ reason: "empty PDF /Users/SECRET" }) });
  f.receipt("extract-failed", "failed", { extraction_processed_at: OLD, extraction_json: JSON.stringify({ reason: "UnidentifiedImageError SECRET" }) });
  f.receipt("manifest"); f.sqlite.exec("DELETE FROM receipt_files WHERE object_id = 'manifest'");
  const snapshot = await loadDigestSnapshot(f.db, NOW);
  assert.deepEqual(snapshot.health?.lit.map((r) => r.kind), ["never_enqueued", "missing_manifest", "render_failed", "extraction_failed", "consumer_stalled", "render_stalled"]);
  const message = composePipelineDigest(snapshot, NOW);
  assert.match(message.subject, /ATTENTION/);
  assert.match(message.text, /never_enqueued: 7; oldest 10d/);
  assert.match(message.text, /Showing oldest 5 of 7 \(cap 5/);
  assert.match(message.text, /never-0.pdf/); assert.doesNotMatch(message.text, /never-5.pdf|never-6.pdf|SECRET/);
  assert.match(message.text, /Empty source or rendered file/); assert.match(message.text, /Undecodable source image/);
  assert.match(message.text, /https:\/\/dazbeez.com\/receipts\/review\/manifest/);
  assert.equal(DIGEST_DETAIL_CAP, 5);
});

test("strict stall threshold, recent pending, needs_render, soft-delete, and manifested exclusions", async (t) => {
  const f = fixture(t); f.statements();
  const threshold = new Date(NOW - 20 * 60 * 1000).toISOString();
  f.receipt("boundary", "queued", { extraction_enqueued_at: threshold });
  f.receipt("fresh-render", "captured", { needs_render: 1, captured_at: threshold });
  f.receipt("deleted", "failed", { deleted_at: OLD });
  const snapshot = await loadDigestSnapshot(f.db, NOW);
  assert.equal(snapshot.health?.ok, true);
});

test("missing statements use canonical eligibility and ignore user dismissals", async (t) => {
  const f = fixture(t);
  f.artifact("2026-11", "uploaded"); f.artifact("2026-10", "failed"); f.artifact("2026-09", "replaced");
  f.insert("dashboard_alert_dismissals", { id: "dismissed", alert_type: "amex_statement_missing", alert_key: "2026-10", dismissed_by: "operator", expires_at: "2099-01-01" });
  const snapshot = await loadDigestSnapshot(f.db, NOW);
  assert.deepEqual(snapshot.missingStatements?.map((m) => m.statementMonth), ["2026-10", "2026-09"]);
  const text = composePipelineDigest(snapshot, NOW).text;
  assert.match(text, /2026-10 — expected ready 2026-09-18/);
  assert.match(text, /global; dashboard dismissals ignored/);
});

test("month expectation handles month-end and January rollover once for dashboard and digest", () => {
  assert.deepEqual(expectedStatementMonths(new Date("2026-03-31T23:30Z")).map((m) => m.statementMonth), ["2026-03", "2026-02", "2026-01"]);
  assert.deepEqual(expectedStatementMonths(new Date("2026-01-01T00:00Z"))[1], { statementMonth: "2025-12", expectedReadyDate: "2025-11-18" });
});

test("delivery queries honor latest finalized revision and attempt history, never denormalized sent state", async (t) => {
  const f = fixture(t); f.statements();
  f.export("old", "2026-06", 1); f.delivery("old-sent", "old", "sent");
  f.export("new", "2026-06", 2); // superseded sent does not close corrected pack
  f.export("draft", "2026-06", 3, "draft");
  f.export("failed", "2026-07"); f.delivery("fail", "failed", "failed");
  f.export("ambiguous", "2026-08"); f.delivery("amb", "ambiguous", "ambiguous");
  f.export("pending", "2026-09"); f.delivery("pend", "pending", "pending");
  f.export("sent", "2026-10"); f.delivery("sent-a", "sent", "sent");
  f.export("resend", "2026-11"); f.delivery("resend-a", "resend", "sent"); f.delivery("resend-b", "resend", "failed", "2026-11-10");
  const snapshot = await loadDigestSnapshot(f.db, NOW);
  assert.deepEqual(snapshot.undelivered, [
    { month: "2026-11", state: "sealed_undelivered" }, { month: "2026-09", state: "pending" },
    { month: "2026-08", state: "sealed_undelivered" }, { month: "2026-07", state: "sealed_undelivered" },
    { month: "2026-06", state: null },
  ]);
  assert.match(composePipelineDigest(snapshot, NOW).text, /export\?month=2026-06/);
});

test("latest-finalized revision tie uses created_at; same attempt sent remains canonical", () => {
  const exports = [
    { id: "a", export_month: "2026-09", status: "finalized", export_revision: null, created_at: "a" },
    { id: "b", export_month: "2026-09", status: "finalized", export_revision: 1, created_at: "b" },
  ];
  assert.equal(finalizedMonthsDeliveryState(exports, [{ export_id: "a", attempt_id: "a", state: "sent", created_at: "z" }]).get("2026-09"), null);
  assert.equal(finalizedMonthsDeliveryState(exports, [
    { export_id: "b", attempt_id: "b", state: "sent", created_at: "a" },
    { export_id: "b", attempt_id: "b", state: "pending", created_at: "z" },
  ]).get("2026-09"), "delivered");
});

for (const failure of ["receipt_records", "amex_statement_artifacts", "export_deliveries", "receipt_exports"]) {
  test(`query failure in ${failure} never earns all-clear or leaks exception`, async (t) => {
    const f = fixture(t); f.statements(); f.failSql = new RegExp(failure);
    const message = composePipelineDigest(await loadDigestSnapshot(f.db, NOW), NOW);
    assert.match(message.subject, /DATA UNAVAILABLE/); assert.doesNotMatch(message.text, /ALL CLEAR|All checks completed|secret/);
  });
}
for (const failure of ["missingAggregate", "missingResults", "unsuccessful"] as const) {
  test(`partial ${failure} query shape is unavailable, never healthy`, async (t) => {
    const f = fixture(t); f.statements(); f[failure] = true;
    assert.match(composePipelineDigest(await loadDigestSnapshot(f.db, NOW), NOW).subject, /DATA UNAVAILABLE/);
  });
}

test("failed or inconsistent detail query preserves count with explicit unavailable status", async (t) => {
  const f = fixture(t); f.statements(); f.receipt("stuck", "captured");
  f.failSql = /SELECT id, original_filename/;
  const snapshot = await loadDigestSnapshot(f.db, NOW);
  assert.equal(snapshot.health?.lit[0].count, 1);
  assert.equal(snapshot.details.never_enqueued.unavailable, true);
  assert.match(composePipelineDigest(snapshot, NOW).text, /Receipt details unavailable/);
  snapshot.details = {};
  assert.match(composePipelineDigest(snapshot, NOW).subject, /DATA UNAVAILABLE/);
});

test("count/detail disagreement is explicitly partial, not an empty affected set", async (t) => {
  const f = fixture(t); f.statements(); f.receipt("changed-population", "captured"); f.emptyDetails = true;
  const snapshot = await loadDigestSnapshot(f.db, NOW);
  assert.equal(snapshot.health?.lit[0].count, 1);
  assert.equal(snapshot.details.never_enqueued.unavailable, true);
  assert.match(composePipelineDigest(snapshot, NOW).subject, /DATA UNAVAILABLE/);
});

test("plain text sanitizes filename controls, encodes links, and redacts arbitrary failure text", () => {
  const snapshot: DigestSnapshot = { health: { ok: false, lit: [{ kind: "extraction_failed", severity: "error", count: 1, oldestAgeMs: null, summary: "unused" }] },
    details: { extraction_failed: { total: 1, rows: [{ id: "a/../?x", original_filename: "<img>\nALL CLEAR\u202e".repeat(30), ageMs: NaN, reason: "token=SECRET" }] } }, missingStatements: [], undelivered: [] };
  const message = composePipelineDigest(snapshot, NOW);
  assert.match(message.text, /review\/a%2F\.\.%2F%3Fx/);
  assert.doesNotMatch(message.text, /SECRET|\u202e|NaN|\nALL CLEAR/);
  assert.match(message.text, /oldest unknown/); assert.equal(safeDigestFailureReason(null), "Failure reason unavailable; inspect review screen");
});

test("disabled/unset recipient/missing provider/invalid recipient never query or fetch; no accountant fallback", async () => {
  const db = { prepare() { throw new Error("must not query"); } } as unknown as D1Database;
  const noFetch: typeof fetch = async () => { throw new Error("must not send"); };
  assert.equal((await runPipelineDigest(db, {}, NOW, noFetch)).status, "disabled");
  assert.deepEqual(await runPipelineDigest(db, { ...config, DIGEST_TO: undefined }, NOW, noFetch), { status: "disabled", reason: "DIGEST_TO unset; recipient confirmation pending" });
  for (const cfg of [{ ...config, RESEND_API_KEY: "" }, { ...config, NOTIFY_FROM_ADDRESS: "" }, { ...config, DIGEST_TO: "a@example.com,b@example.com" }]) {
    assert.equal((await runPipelineDigest(db, cfg, NOW, noFetch)).status, "misconfigured");
  }
});

test("mocked provider accepts plain text with stable per-JST-day recipient/scope ASCII idempotency", async (t) => {
  const f = fixture(t); f.statements(); let sends = 0;
  const fetchMock: typeof fetch = async (url, init) => {
    sends++; assert.equal(url, "https://api.resend.com/emails");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Idempotency-Key"), await digestIdempotencyKey(NOW, config.DIGEST_TO));
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.to, [config.DIGEST_TO]); assert.equal(body.html, undefined); assert.equal(body.cc, undefined);
    assert.match(body.text, /ALL CLEAR/); return Response.json({ id: "mock-id" });
  };
  assert.deepEqual(await runPipelineDigest(f.db, config, NOW, fetchMock), { status: "accepted", dataUnavailable: false });
  assert.equal(sends, 1);
  const key = await digestIdempotencyKey(NOW, " OPERATOR@EXAMPLE.COM ");
  assert.equal(key, await digestIdempotencyKey(NOW + 60_000, config.DIGEST_TO));
  assert.notEqual(key, await digestIdempotencyKey(NOW + 86_400_000, config.DIGEST_TO));
  assert.notEqual(key, await digestIdempotencyKey(NOW, "another@example.com"));
  assert.match(key, /^[\x20-\x7e]+$/); assert.ok(key.length < 256);
  assert.equal(digestDate(Date.parse("2026-11-11T14:59:59Z")), "2026-11-11");
  assert.equal(digestDate(Date.parse("2026-11-11T15:00:00Z")), "2026-11-12");
});

test("provider rejection/network errors never report acceptance or leak provider text; unavailable data sends honest warning", async (t) => {
  const f = fixture(t); f.statements();
  for (const fetchMock of [async () => Response.json({ message: "SECRET" }, { status: 503 }), async () => { throw new Error("SECRET"); }]) {
    const result = await runPipelineDigest(f.db, config, NOW, fetchMock);
    assert.equal(result.status, "send_failed"); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
  f.failSql = /amex_statement_artifacts/;
  const result = await runPipelineDigest(f.db, config, NOW, async (_url, init) => {
    assert.match(JSON.parse(String(init?.body)).subject, /DATA UNAVAILABLE/); return Response.json({ id: "mock" });
  });
  assert.deepEqual(result, { status: "accepted", dataUnavailable: true });
});
