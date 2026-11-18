// Actual upload/capture/enqueue handlers; only auth and Cloudflare bindings are substituted.
import test, { beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

interface RawStmt {
  get(...p: unknown[]): Record<string, unknown> | undefined;
  all(...p: unknown[]): Record<string, unknown>[];
  run(...p: unknown[]): { changes: number | bigint };
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStmt;
  close(): void;
}
type Spec = { sql: string; args: unknown[] };

class SqliteD1 {
  readonly db: RawDb;
  before: ((sql: string) => Promise<void>) | null = null;
  after: ((sql: string) => Promise<void>) | null = null;
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- installed @types/node predates node:sqlite
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => RawDb };
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(`db/receipts/${file}`, "utf8"));
    }
  }
  prepare(sql: string) {
    const make = (args: unknown[]) => ({
      spec: { sql, args },
      bind: (...args: unknown[]) => make(args),
      first: async <T>() => {
        await this.before?.(sql);
        const result = (this.db.prepare(sql).get(...args) ?? null) as T | null;
        await this.after?.(sql);
        return result;
      },
      all: async <T>() => {
        await this.before?.(sql);
        const results = this.db.prepare(sql).all(...args) as T[];
        await this.after?.(sql);
        return { results };
      },
      run: async () => {
        await this.before?.(sql);
        const result = this.db.prepare(sql).run(...args);
        await this.after?.(sql);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    });
    return make([]);
  }
  async batch(statements: { spec: Spec }[]) {
    this.db.exec("BEGIN");
    try {
      const result = [];
      for (const { spec } of statements) {
        await this.before?.(spec.sql);
        const info = this.db.prepare(spec.sql).run(...spec.args);
        result.push({ success: true, meta: { changes: Number(info.changes) } });
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  asD1() { return this as unknown as D1Database; }
}

class Bucket {
  objects = new Map<string, Uint8Array>();
  puts: string[] = [];
  deletes: string[] = [];
  async put(key: string, bytes: ArrayBuffer, options?: { onlyIf?: { etagDoesNotMatch: string } }) {
    if (options?.onlyIf && this.objects.has(key)) return null;
    this.puts.push(key);
    this.objects.set(key, new Uint8Array(bytes));
    return {};
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
  }
  async delete(key: string) { this.deletes.push(key); this.objects.delete(key); }
}
let d1: SqliteD1;
let bucket: Bucket;
let sends: { receiptId: string; r2Key: string }[];
let queueFails: boolean;
let queueBindingFails: boolean;
let queuePause: (() => Promise<void>) | null;
mock.module("@/lib/cloudflare-runtime", { namedExports: {
  getReceiptsDb: () => d1.asD1(),
  getReceiptsBucket: () => bucket,
  getReceiptsArchiveBucket: () => bucket,
  getReceiptsProcessorKey: () => null,
  getReceiptsQueue: () => {
    if (queueBindingFails) throw new Error("interrupted before queue send");
    return { send: async (job: { receiptId: string; r2Key: string }) => {
    if (queueFails) throw new Error("injected queue outage");
    sends.push(job);
    await queuePause?.();
  } };
  },
} });
mock.module("@/lib/receipts/auth", { namedExports: {
  requireReceiptsActor: async (headers: Headers) => {
    const actor = headers.get("x-test-actor");
    if (!actor) throw new Error("Unauthorized");
    return actor;
  },
} });
mock.module("@/lib/receipts/trusted-devices", { namedExports: {
  requireMobileActor: async (headers: Headers, scope: string) => {
    assert.equal(scope, "receipt:create");
    if (!headers.get("x-test-device")) throw new Error("Unauthorized");
    return { actor: "native-actor", deviceId: headers.get("x-test-device") };
  },
} });
const upload = async (request: Request) => (await import("@/app/api/receipts/upload/route")).POST(request);
const mobile = async (request: Request) => (await import("@/app/api/mobile/receipts/upload/route")).POST(request);
const enqueue = async (id: string) => (await import("@/app/api/receipts/[id]/enqueue/route")).POST(
  new Request(`http://localhost/api/receipts/${id}/enqueue`, { method: "POST", headers: { "x-test-actor": "recovery-operator" } }),
  { params: Promise.resolve({ id }) },
);
beforeEach(() => { d1 = new SqliteD1(); bucket = new Bucket(); sends = []; queueFails = false; queueBindingFails = false; queuePause = null; });
afterEach(() => d1.db.close());

type RequestOptions = { actor?: string; bytes?: string; metadata?: Record<string, string>; filename?: string; type?: string };
function request(key: string | null = "capture-1", options: RequestOptions = {}) {
  const fd = new FormData();
  fd.append("file", new File([options.bytes ?? "receipt bytes"], options.filename ?? "receipt.jpg", { type: options.type ?? "image/jpeg" }));
  fd.append("source", "mobile_capture");
  fd.append("paymentPath", "AMEX");
  if (key !== null) fd.append("client_capture_id", key);
  for (const [k, v] of Object.entries(options.metadata ?? {})) fd.set(k, v);
  return new Request("http://localhost/api/receipts/upload", { method: "POST", body: fd, headers: { "x-test-actor": options.actor ?? "actor-a" } });
}
const json = async (response: Response) => await response.json() as { code?: string; receiptId?: string; extractionState?: string };
const rows = () => d1.db.prepare("SELECT * FROM receipt_records").all();
const manifests = () => d1.db.prepare("SELECT * FROM receipt_files").all();
const audits = (action = "receipt.uploaded") => d1.db.prepare("SELECT * FROM receipt_audit_log WHERE action = ?").all(action);
function assertCounts(receipts: number, files: number, jobs: number, uploads = receipts, objects = receipts) {
  assert.equal(rows().length, receipts, "receipts");
  assert.equal(manifests().length, files, "original manifests");
  assert.equal(sends.length, jobs, "accepted queue jobs");
  assert.equal(audits().length, uploads, "uploaded audits");
  assert.equal(bucket.objects.size, objects, "surviving R2 originals");
}
function assertOriginal() {
  const row = rows()[0];
  assert.deepEqual(bucket.objects.get(String(row.original_r2_key)), new TextEncoder().encode("receipt bytes"));
  assert.ok(!bucket.deletes.includes(String(row.original_r2_key)), "winner's original never deleted");
}
function pause() {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reached = resolve; });
  return { release, entered, wait: async () => { reached(); await gate; } };
}

// Successful response discarded: later mutable fields do not redefine the request.
test("lost success response replays ID after operator edits without extra manifest/job/audit", async () => {
  const first = await upload(request());
  assert.equal(first.status, 201);
  const id = rows()[0].id;
  d1.db.prepare("UPDATE receipt_records SET payment_path='CASH', source_type='manual_upload', merchant='edited', status='reviewed' WHERE id=?").run(id);
  const replay = await upload(request());
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).receiptId, id);
  assertCounts(1, 1, 1);
  assertOriginal();
  assert.equal(bucket.puts.length, 2);
  assert.deepEqual(bucket.deletes, [bucket.puts[1]]);
  assert.equal(manifests()[0].r2_key, rows()[0].original_r2_key);
  const audit = JSON.parse(String(audits()[0].new_value_json));
  assert.equal(audit.client_capture_id, "capture-1");
  assert.equal(audits()[0].actor, "actor-a");
});

test("overlapping identical requests race at INSERT: one receipt and one complete replay", async () => {
  const gate = pause(); let inserts = 0;
  d1.before = async (sql) => {
    if (sql.includes("INSERT INTO receipt_records") && ++inserts === 1) await gate.wait();
  };
  const first = upload(request());
  await gate.entered;
  const winner = await upload(request());
  assert.equal(winner.status, 201);
  gate.release();
  const loser = await first;
  assert.equal(loser.status, 200);
  assert.equal((await json(loser)).receiptId, rows()[0].id);
  assertCounts(1, 1, 1);
  assertOriginal();
  assert.equal(bucket.deletes.length, 1);
});

test("retry before manifest gets retry-later, cannot delete/replace/enqueue winner", async () => {
  const gate = pause(); let manifestCalls = 0;
  d1.before = async (sql) => { if (sql.includes("INSERT INTO receipt_files") && ++manifestCalls === 1) await gate.wait(); };
  const winner = upload(request());
  await gate.entered;
  const retry = await upload(request());
  assert.equal(retry.status, 503);
  assert.equal(retry.headers.get("Retry-After"), "5");
  const body = await json(retry);
  assert.equal(body.code, "capture_incomplete");
  assert.equal(body.receiptId, rows()[0].id);
  assertCounts(1, 0, 0);
  assertOriginal();
  assert.equal((await upload(request("capture-1", { bytes: "changed during capture" }))).status, 409);
  assertCounts(1, 0, 0);
  assertOriginal();
  gate.release();
  assert.equal((await winner).status, 201);
  assertCounts(1, 1, 1);
});

test("retry while enqueue acknowledgement is pending stays incomplete", async () => {
  const gate = pause(); queuePause = gate.wait;
  const winner = upload(request());
  await gate.entered;
  assert.equal((await upload(request())).status, 503);
  assertCounts(1, 1, 1);
  assertOriginal();
  gate.release();
  assert.equal((await winner).status, 201);
  assert.equal((await upload(request())).status, 200);
  assertCounts(1, 1, 1);
});

test("same key across actors or fresh keys for identical bytes create independent receipts", async () => {
  assert.equal((await upload(request())).status, 201);
  assert.equal((await upload(request("capture-1", { actor: "actor-b" }))).status, 201);
  assert.equal((await upload(request("capture-2"))).status, 201);
  assertCounts(3, 3, 3);
  assert.equal(new Set(rows().map((r) => r.id)).size, 3);
  assert.deepEqual(rows().map((r) => r.captured_by).sort(), ["actor-a", "actor-a", "actor-b"]);
});

test("same actor/key with changed bytes or any capture metadata returns explicit 409", async () => {
  assert.equal((await upload(request())).status, 201);
  const original = rows()[0];
  const changes: RequestOptions[] = [
    { bytes: "different" }, { metadata: { source: "desktop_upload" } },
    { metadata: { sourceType: "manual_upload" } }, { metadata: { paymentPath: "CASH" } },
    { metadata: { expenseType: "MEALS" } }, { filename: "different.jpg" }, { type: "image/png" },
  ];
  for (const options of changes) {
    const res = await upload(request("capture-1", options));
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, "capture_key_conflict");
    assert.deepEqual(rows()[0], original);
    assertCounts(1, 1, 1);
    assertOriginal();
  }
});

test("request fingerprint is immutable in SQLite and remains distinct from operator fields", async () => {
  await upload(request());
  assert.throws(() => d1.db.exec("UPDATE receipt_records SET capture_request_fingerprint='changed'"), /fingerprint is immutable/);
  assert.throws(() => d1.db.exec("UPDATE receipt_records SET capture_request_fingerprint=NULL"), /fingerprint is immutable/);
  assertCounts(1, 1, 1);
});

test("manifest failure compensates loudly; same key can capture after rollback", async () => {
  d1.before = async (sql) => { if (sql.includes("INSERT INTO receipt_files")) throw new Error("injected manifest failure"); };
  const res = await upload(request());
  assert.equal(res.status, 500);
  assert.equal((await json(res)).code, "capture_manifest_failed");
  assertCounts(0, 0, 0, 1, 0);
  assert.equal(audits("receipt.deleted").length, 1);
  assert.ok(bucket.deletes.includes(bucket.puts[0]));
  d1.before = null;
  assert.equal((await upload(request())).status, 201);
  assertCounts(1, 1, 1, 2);
});

test("queue outage is completed capture with marker, replay cannot enqueue; health recovery reuses ID", async () => {
  queueFails = true;
  const res = await upload(request());
  assert.equal(res.status, 201);
  assert.equal((await json(res)).extractionState, "captured");
  assert.ok(rows()[0].extraction_enqueue_failed_at);
  assert.equal(rows()[0].extraction_enqueued_at, null);
  assert.equal((await upload(request())).status, 200);
  assertCounts(1, 1, 0);
  const { getPipelineHealth } = await import("@/lib/receipts/pipeline-health");
  assert.ok((await getPipelineHealth(d1.asD1())).lit.some((r) => r.kind === "never_enqueued"));
  queueFails = false;
  assert.equal((await enqueue(String(rows()[0].id))).status, 200);
  assert.equal((await upload(request())).status, 200);
  assertCounts(1, 1, 1);
  assert.equal(rows()[0].extraction_enqueue_failed_at, null);
  assert.equal(audits("receipt.extraction_enqueued").length, 1);
});

test("other INSERT failure is 500, not a collision; unreferenced candidate is deleted", async () => {
  d1.before = async (sql) => { if (sql.includes("INSERT INTO receipt_records")) throw new Error("D1_ERROR: disk unavailable"); };
  const res = await upload(request());
  assert.equal(res.status, 500);
  assertCounts(0, 0, 0);
  assert.deepEqual(bucket.deletes, bucket.puts);
});

test("post-INSERT interruption retains original and exposes incomplete; operator repairs same ID before enqueue", async () => {
  d1.after = async (sql) => { if (sql.includes("INSERT INTO receipt_records")) throw new Error("lost INSERT acknowledgement"); };
  const first = await upload(request());
  assert.equal(first.status, 503);
  assert.equal((await json(first)).receiptId, rows()[0].id);
  assertCounts(1, 0, 0, 0);
  assertOriginal();
  d1.after = null;
  assert.equal((await upload(request())).status, 503);
  assertCounts(1, 0, 0, 0);
  const { getPipelineHealth } = await import("@/lib/receipts/pipeline-health");
  const health = await getPipelineHealth(d1.asD1());
  assert.ok(health.lit.some((r) => r.kind === "missing_manifest"));
  assert.ok(health.lit.some((r) => r.kind === "never_enqueued"));
  // Simulate confirmed-inactive operator recovery, never automatic request takeover.
  const { createReceiptFile } = await import("@/lib/receipts/files");
  const { buildCaptureFileInput } = await import("@/lib/receipts/capture");
  const { createAuditEntry } = await import("@/lib/receipts/audit");
  const r = rows()[0];
  await createAuditEntry(d1.asD1(), { actor: "actor-a", action: "receipt.uploaded", objectType: "receipt", objectId: String(r.id),
    newValueJson: JSON.stringify({ paymentPath: r.payment_path, expenseType: r.expense_type, source: r.source, client_capture_id: r.client_capture_id, recoveredBy: "recovery-operator" }) });
  await createReceiptFile(d1.asD1(), buildCaptureFileInput({ receiptId: String(r.id), r2Key: String(r.original_r2_key), actor: "actor-a",
    file: { sha256: String(r.original_sha256), sizeBytes: Number(r.original_size_bytes), contentType: String(r.original_content_type), filename: String(r.original_filename) } }));
  assert.equal((await upload(request())).status, 503, "manifest alone is not complete");
  assert.equal((await enqueue(String(r.id))).status, 200);
  assert.equal((await upload(request())).status, 200);
  assertCounts(1, 1, 1);
  assertOriginal();
});

test("audit failure after INSERT does not destroy original or acknowledge incomplete capture", async () => {
  d1.before = async (sql) => { if (sql.includes("INSERT INTO receipt_audit_log")) throw new Error("audit unavailable"); };
  const first = await upload(request());
  assert.equal(first.status, 503);
  assertCounts(1, 0, 0, 0);
  assertOriginal();
  d1.before = null;
  assert.equal((await upload(request())).status, 503);
  assertCounts(1, 0, 0, 0);
});

test("crash after manifest and before enqueue is incomplete, health enqueue completes same receipt", async () => {
  queueBindingFails = true;
  const interrupted = await upload(request());
  assert.equal(interrupted.status, 503);
  assert.equal((await json(interrupted)).receiptId, rows()[0].id);
  assertCounts(1, 1, 0);
  assertOriginal();
  queueBindingFails = false;
  assert.equal((await upload(request())).status, 503);
  assertCounts(1, 1, 0);
  assert.equal((await enqueue(String(rows()[0].id))).status, 200);
  assert.equal((await upload(request())).status, 200);
  assertCounts(1, 1, 1);
  assertOriginal();
});

test("D1 failure recording enqueue leaves uncertain state; replay never sends again or deletes original", async () => {
  d1.before = async (sql) => { if (sql.includes("SET extraction_state = ?")) throw new Error("outcome write interrupted"); };
  const res = await upload(request());
  assert.equal(res.status, 503);
  assertCounts(1, 1, 1);
  assertOriginal();
  d1.before = null;
  assert.equal((await upload(request())).status, 503);
  assertCounts(1, 1, 1);
});

test("committed outcome with lost D1 acknowledgement can replay on next request", async () => {
  d1.after = async (sql) => { if (sql.includes("SET extraction_state = ?")) throw new Error("outcome acknowledgement lost"); };
  assert.equal((await upload(request())).status, 503);
  d1.after = null;
  assert.equal((await upload(request())).status, 200);
  assertCounts(1, 1, 1);
  assertOriginal();
});

test("legacy no-key calls stay independent and browser ignores client-supplied actor/device", async () => {
  assert.equal((await upload(request(null))).status, 201);
  assert.equal((await upload(request(null))).status, 201);
  assert.equal((await upload(request("capture-1", { metadata: { device_id: "fake-device", captured_by: "someone-else" } }))).status, 201);
  assert.equal((await upload(request())).status, 200);
  assertCounts(3, 3, 3);
  assert.ok(rows().every((r) => r.device_id === null && r.captured_by === "actor-a"));
});

test("invalid key/auth/source/file rejects before storage", async () => {
  for (const key of ["", "with spaces", "x".repeat(129)]) assert.equal((await upload(request(key))).status, 400);
  assert.equal((await upload(request("capture-1", { actor: "" }))).status, 401);
  assert.equal((await upload(request("capture-1", { metadata: { source: "forged" } }))).status, 400);
  assert.equal((await upload(new Request("http://localhost", { method: "POST", body: new FormData(), headers: { "x-test-actor": "actor-a" } }))).status, 400);
  assertCounts(0, 0, 0);
  assert.equal(bucket.puts.length, 0);
});

test("native device-scoped lookup/replay and provenance unchanged; browser key does not collide", async () => {
  const nativeRequest = (device: string) => {
    const fd = new FormData();
    fd.append("file", new File(["native bytes"], "photo.jpg", { type: "image/jpeg" }));
    fd.append("client_capture_id", "capture-1");
    fd.append("captured_at_client", "2026-11-18T10:00:00Z");
    fd.append("app_version", "1.2.3"); fd.append("note", "native note"); fd.append("payment_hint", "CASH");
    return new Request("http://localhost/api/mobile/receipts/upload", { method: "POST", body: fd, headers: { "x-test-device": device } });
  };
  assert.equal((await mobile(nativeRequest("device-a"))).status, 201);
  const row = rows()[0];
  assert.equal(row.device_id, "device-a");
  assert.equal(row.upload_origin, "mobile");
  assert.equal(row.captured_at_client, "2026-11-18T10:00:00Z");
  assert.equal(row.preservation_status, "needs_metadata");
  const audit = JSON.parse(String(audits()[0].new_value_json));
  assert.equal(audit.app_version, "1.2.3"); assert.equal(audit.note, "native note"); assert.equal(audit.device_id, "device-a");
  assert.equal((await mobile(nativeRequest("device-a"))).status, 200);
  assert.equal((await mobile(nativeRequest("device-b"))).status, 201);
  assert.equal((await upload(request("capture-1", { actor: "native-actor" }))).status, 201);
  assertCounts(3, 3, 3);
  assert.equal(bucket.puts.length, 3, "native replay preflight doesn't upload");
});

test("both email paths retain canonical manifest/enqueue or render deferral", async () => {
  const { captureReceipt } = await import("@/lib/receipts/capture");
  for (const body of [false, true]) {
    const bytes = new TextEncoder().encode(body ? "email text" : "attachment");
    const key = body ? "intake/body" : "intake/attachment";
    await bucket.put(key, bytes.buffer);
    const contentType = body ? "text/plain" : "application/pdf";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = await captureReceipt({
      record: { capturedBy: "sender@example.com", source: "email", sourceType: body ? "email_body" : "email_attachment", status: "captured",
        originalFilename: "email", originalR2Key: key, originalSha256: sha256, originalContentType: contentType, originalSizeBytes: bytes.length },
      actor: "promoter", file: { sha256, sizeBytes: bytes.length, contentType, filename: "email" },
      r2Strategy: { kind: "intake-copy", intakeKey: key }, enqueue: !body,
    });
    const r = rows().find((r) => r.id === result.receiptId)!;
    assert.equal(r.needs_render, body ? 1 : 0);
    assert.equal(result.enqueued, !body);
    assert.equal(manifests().find((f) => f.object_id === r.id)?.r2_key, result.r2Key);
    assert.deepEqual(bucket.objects.get(result.r2Key), bytes);
  }
  assertCounts(2, 2, 1, 2, 4); // Intake copies remain owned by their callers.
});

test("concurrent in-progress loser stays incomplete when winner's manifest rolls back", async () => {
  const gate = pause(); let calls = 0;
  d1.before = async (sql) => {
    if (sql.includes("INSERT INTO receipt_files") && ++calls === 1) {
      await gate.wait();
      throw new Error("manifest unavailable");
    }
  };
  const winner = upload(request());
  await gate.entered;
  assert.equal((await upload(request())).status, 503);
  assertCounts(1, 0, 0);
  assertOriginal();
  gate.release();
  assert.equal((await winner).status, 500);
  assertCounts(0, 0, 0, 1, 0);
  d1.before = null;
  assert.equal((await upload(request())).status, 201);
  assertCounts(1, 1, 1, 2);
});

test("loser INSERT collision after winner rollback is retry-later, not phantom success", async () => {
  let manifestFails = true;
  let collisionObserved = false;
  const gate = pause();
  const originalPrepare = d1.prepare.bind(d1);
  d1.prepare = (sql: string) => {
    const make = (args: unknown[]): ReturnType<SqliteD1["prepare"]> => {
      const statement = originalPrepare(sql).bind(...args);
      return { ...statement, bind: (...args: unknown[]) => make(args), run: async () => {
        try { return await statement.run(); }
        catch (error) {
          if (sql.includes("INSERT INTO receipt_records") && String(error).includes("UNIQUE constraint")) {
            collisionObserved = true;
            await gate.wait();
          }
          throw error;
        }
      } };
    };
    return make([]);
  };
  const manifestGate = pause();
  d1.before = async (sql) => {
    if (manifestFails && sql.includes("INSERT INTO receipt_files")) {
      await manifestGate.wait();
      throw new Error("manifest rollback");
    }
  };
  const winner = upload(request());
  await manifestGate.entered;
  const loser = upload(request());
  await gate.entered;
  assert.ok(collisionObserved);
  manifestGate.release();
  assert.equal((await winner).status, 500);
  gate.release();
  const res = await loser;
  assert.equal(res.status, 503);
  assert.equal((await json(res)).code, "capture_incomplete");
  assertCounts(0, 0, 0, 1, 0);
  manifestFails = false;
  assert.equal((await upload(request())).status, 201);
  assertCounts(1, 1, 1, 2);
});

test("unknown D1 ownership retains candidate for inspection rather than deleting a possibly committed original", async () => {
  d1.after = async (sql) => { if (sql.includes("INSERT INTO receipt_records")) throw new Error("lost insert acknowledgement"); };
  d1.before = async (sql) => { if (sql.includes("r.capture_request_fingerprint")) throw new Error("ownership lookup unavailable"); };
  assert.equal((await upload(request())).status, 500);
  assertCounts(1, 0, 0, 0);
  assertOriginal();
  d1.after = null; d1.before = null;
  assert.equal((await upload(request())).status, 503);
  assertCounts(1, 0, 0, 0);
});

test("a missing or wrong original manifest cannot replay despite an enqueue timestamp", async () => {
  await upload(request());
  d1.db.exec("UPDATE receipt_files SET is_original=0");
  assert.equal((await upload(request())).status, 503);
  d1.db.exec("UPDATE receipt_files SET is_original=1, sha256_hash='wrong'");
  assert.equal((await upload(request())).status, 503);
  d1.db.exec("UPDATE receipt_files SET sha256_hash=(SELECT original_sha256 FROM receipt_records), r2_key='wrong-key'");
  assert.equal((await upload(request())).status, 503);
  assertCounts(1, 1, 1);
  assertOriginal();
});

test("soft-deleted receipts retain their key and cannot be resurrected by replay", async () => {
  await upload(request());
  d1.db.exec("UPDATE receipt_records SET deleted_at='2026-11-18T11:00:00Z'");
  const res = await upload(request());
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, "capture_key_conflict");
  assertCounts(1, 1, 1);
  assertOriginal();
});

test("native overlapping calls still resolve the native INSERT collision with one capture", async () => {
  const nativeRequest = () => {
    const fd = new FormData();
    fd.append("file", new File(["receipt bytes"], "photo.jpg", { type: "image/jpeg" }));
    fd.append("client_capture_id", "capture-1");
    return new Request("http://localhost/api/mobile/receipts/upload", { method: "POST", body: fd, headers: { "x-test-device": "device-a" } });
  };
  const gate = pause(); let reads = 0;
  d1.after = async (sql) => { if (sql.includes("SELECT id, status FROM receipt_records") && ++reads === 1) await gate.wait(); };
  const first = mobile(nativeRequest());
  await gate.entered;
  assert.equal((await mobile(nativeRequest())).status, 201);
  gate.release();
  assert.equal((await first).status, 200);
  assertCounts(1, 1, 1);
  assertOriginal();
  assert.equal(bucket.puts.length, 2);
  assert.equal(bucket.deletes.length, 1);
});

test("actual first-party upload hook sends stable keys and keeps new selections distinct", async () => {
  // Hook state wiring is substituted; the upload function, FormData, resizing,
  // fetch request and server capture are real. No DOM dependency is needed.
  const react = mock.module("react", { namedExports: {
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [value, () => {}],
    useCallback: (callback: unknown) => callback,
  } });
  const originalFetch = globalThis.fetch;
  const keys: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const fd = init?.body as FormData;
    keys.push(String(fd.get("client_capture_id")));
    return upload(new Request("http://localhost/api/receipts/upload", { ...init, headers: { "x-test-actor": "actor-a" } }));
  }) as typeof fetch;
  try {
    const { useReceiptUpload } = await import("@/components/receipts/capture/use-receipt-upload");
    const hook = useReceiptUpload();
    const file = new File(["receipt bytes"], "photo.jpg", { type: "image/jpeg" });
    const first = await hook.upload(file, "AMEX", "desktop_upload");
    const replay = await hook.upload(file, "AMEX", "desktop_upload");
    const other = await hook.upload(new File(["receipt bytes"], "photo.jpg", { type: "image/jpeg" }), "AMEX", "desktop_upload");
    assert.ok(first.ok && replay.ok && other.ok);
    assert.equal(first.receiptId, replay.receiptId);
    assert.notEqual(first.receiptId, other.receiptId);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assertCounts(2, 2, 2);
  } finally { globalThis.fetch = originalFetch; react.restore(); }
});
