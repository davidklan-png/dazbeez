import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
// @ts-expect-error node:sqlite exists in Node 22 but not @types/node 20.
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(__dirname, "../..");
const require_ = createRequire(path.join(ROOT, "package.json"));
const ts = require_("typescript") as typeof import("typescript");
let database: D1Database;
// Load actual pairing/enrollment writers; substitute only their runtime binding.
const modules = new Map<string, { exports: unknown }>();
function load<T>(file: string): T {
  if (modules.has(file)) return modules.get(file)!.exports as T;
  const module_ = { exports: {} };
  modules.set(file, module_);
  const js = ts.transpileModule(readFileSync(path.join(ROOT, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", js)((name: string) => {
    if (name === "@/lib/cloudflare-runtime") return { getReceiptsDb: () => database };
    if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`);
    return require_(name);
  }, module_, module_.exports);
  return module_.exports as T;
}
const pairing = load<typeof import("../../lib/receipts/mobile-pairing")>("lib/receipts/mobile-pairing.ts");
const devices = load<typeof import("../../lib/receipts/trusted-devices")>("lib/receipts/trusted-devices.ts");
const CODE = "DAZ-ABCD";
const input = { code: CODE, actor: "pairing-test", label: "test phone", userAgent: null,
  platform: "ios" as const, appVersion: null };

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(path.join(tmpdir(), "pairing-"));
  const file = path.join(dir, "test.sqlite");
  const sqlite = new DatabaseSync(file);
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
  for (const name of readdirSync(path.join(ROOT, "db/receipts")).filter(n => n.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(path.join(ROOT, "db/receipts", name), "utf8"));
  }
  const other = new DatabaseSync(file);
  other.exec("PRAGMA foreign_keys=ON");
  assert.equal(sqlite.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(other.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  const secret = process.env.RECEIPTS_DEVICE_SECRET;
  process.env.RECEIPTS_DEVICE_SECRET = "synthetic-pairing-secret-for-tests-only";
  t.after(() => {
    if (secret === undefined) delete process.env.RECEIPTS_DEVICE_SECRET;
    else process.env.RECEIPTS_DEVICE_SECRET = secret;
    other.close(); sqlite.close(); rmSync(dir, { recursive: true });
  });
  let beforeWrite: ((sql: string) => void | Promise<void>) | undefined;
  let afterRead: (() => Promise<void>) | undefined;
  let connectionIndex = 0;
  database = { prepare(sql: string) {
    const connection = [sqlite, other][connectionIndex++ % 2];
    let args: unknown[] = [];
    const stmt = {
      bind(...values: unknown[]) { args = values; return stmt; },
      async first() {
        const row = connection.prepare(sql).get(...args) ?? null;
        if (afterRead && sql.includes("mobile_pairing_codes")) await afterRead();
        return row;
      },
      async run() {
        await beforeWrite?.(sql);
        // D1 admits each standalone write as a transaction; use two real
        // connections, not a SQL recorder or a read-before-write simulation.
        connection.exec("BEGIN IMMEDIATE");
        try {
          const result = connection.prepare(sql).run(...args);
          connection.exec("COMMIT");
          return { success: true, meta: { changes: Number(result.changes) } };
        } catch (error) { connection.exec("ROLLBACK"); throw error; }
      },
    };
    return stmt;
  } } as unknown as D1Database;
  const future = new Date(Date.now() + 300_000).toISOString();
  function seed(expiresAt = future, device: string | null = null, token: string | null = null, code = CODE) {
    sqlite.prepare(`INSERT INTO mobile_pairing_codes
      (code, created_at, expires_at, consumed_device_id, consumed_at, bearer_token)
      VALUES (?, ?, ?, ?, ?, ?)`).run(code, new Date().toISOString(), expiresAt,
      device, device ? new Date().toISOString() : null, token);
  }
  function bothReads() {
    let count = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    afterRead = async () => { if (++count === 2) release(); await gate; };
  }
  return { sqlite, seed, future, bothReads,
    beforeWrite(fn: typeof beforeWrite) { beforeWrite = fn; },
    exactExpiry() {
      return sqlite.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get().now as string;
    },
    row() { return sqlite.prepare("SELECT * FROM mobile_pairing_codes WHERE code=?").get(CODE); },
  };
}

test("valid pending, approved, collected and unknown controls preserve the bearer protocol", async t => {
  const f = fixture(t); f.seed();
  assert.deepEqual(await pairing.checkPairingCode(" daz-abcd "), { status: "pending" });
  assert.deepEqual(await pairing.checkPairingCode("bad"), { status: "not_found" });
  assert.deepEqual(await pairing.checkPairingCode("DAZ-ZZZZ"), { status: "not_found" });
  const { deviceId } = await pairing.completePairing(input);
  assert.equal(f.row().expires_at, f.future, "approval never extends the collection deadline");
  const ready = await pairing.checkPairingCode(CODE);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  assert.equal(ready.deviceId, deviceId);
  const verified = await devices.verifySignedMobileBearer(process.env.RECEIPTS_DEVICE_SECRET!, ready.bearerToken);
  assert.equal(verified?.actor, input.actor);
  assert.equal(verified?.id, deviceId);
  assert.equal(f.row().bearer_token, null);
  assert.deepEqual(await pairing.checkPairingCode(CODE), { status: "not_found" });
  await assert.rejects(pairing.completePairing(input), /already used/);
});

for (const approved of [false, true]) {
  for (const boundary of ["expired", "exact deadline"]) {
    test(`${approved ? "approved" : "pending"} code returns no credential at ${boundary}`, async t => {
      const f = fixture(t);
      const expires = boundary === "expired" ? "2000-01-01T00:00:00.000Z" : f.exactExpiry();
      t.mock.timers.enable({ apis: ["Date"], now: Date.parse(expires) + (boundary === "expired" ? 1 : 0) });
      f.seed(expires, approved ? "approved-device" : null, approved ? "synthetic-token" : null);
      assert.deepEqual(await pairing.checkPairingCode(CODE), { status: "expired" });
      if (!approved) await assert.rejects(pairing.completePairing(input), /expired/);
      await pairing.deleteExpiredPairingCodes();
      assert.equal(f.row(), undefined);
      assert.deepEqual(await pairing.checkPairingCode(CODE), { status: "not_found" });
    });
  }
}

test("simultaneous polls with the same prior SELECT yield exactly one credential", async t => {
  const f = fixture(t); f.seed();
  await pairing.completePairing(input);
  f.bothReads();
  const results = await Promise.all([pairing.checkPairingCode(CODE), pairing.checkPairingCode(CODE)]);
  assert.equal(results.filter(r => r.status === "ready").length, 1);
  assert.deepEqual(results.find(r => r.status !== "ready"), { status: "not_found" });
  assert.equal(f.row().bearer_token, null);
  assert.deepEqual(await pairing.checkPairingCode(CODE), { status: "not_found" });
});

test("simultaneous approvals enroll only one active device and revoke the loser", async t => {
  const f = fixture(t); f.seed(); f.bothReads();
  const results = await Promise.allSettled([pairing.completePairing(input), pairing.completePairing(input)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const rows = f.sqlite.prepare("SELECT id, revoked_at FROM trusted_devices").all();
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r: { revoked_at: string | null }) => r.revoked_at === null).length, 1);
  assert.equal(rows.find((r: { revoked_at: string | null }) => r.revoked_at === null).id, f.row().consumed_device_id);
});

for (const operation of ["approval", "collection"] as const) {
  for (const cleanup of [false, true]) {
    test(`${operation} loses admission at expiry${cleanup ? " with concurrent cleanup" : ""}`, async t => {
      const f = fixture(t); f.seed();
      if (operation === "collection") await pairing.completePairing(input);
      f.beforeWrite(async sql => {
        if (!sql.startsWith("UPDATE mobile_pairing_codes")) return;
        f.beforeWrite(undefined);
        // Expire after the production SELECT/enrollment but before write admission.
        f.sqlite.exec("UPDATE mobile_pairing_codes SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
        if (cleanup) await pairing.deleteExpiredPairingCodes();
      });
      if (operation === "approval") {
        await assert.rejects(pairing.completePairing(input), /used or expired/);
        assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM trusted_devices WHERE revoked_at IS NULL").get().n, 0);
      } else {
        assert.notEqual((await pairing.checkPairingCode(CODE)).status, "ready");
      }
      if (cleanup) assert.equal(f.row(), undefined);
      else {
        assert.equal(f.row().consumed_device_id !== null, operation === "collection");
        await pairing.deleteExpiredPairingCodes();
        assert.equal(f.row(), undefined);
      }
    });
  }
}

test("normal pairing start cleans expired pending/approved rows and retains valid/collected controls", async t => {
  const f = fixture(t); f.seed("2000-01-01T00:00:00.000Z", "expired-device", "synthetic-token");
  f.seed("2000-01-01T00:00:00.000Z", null, null, "DAZ-AAAA");
  f.seed(f.future, "valid-device", "synthetic-token", "DAZ-BBBB");
  f.seed(f.future, null, null, "DAZ-CCCC");
  f.seed("2000-01-01T00:00:00.000Z", "collected-device", null, "DAZ-DDDD");
  f.seed("2000-01-01T00:00:00.000Z", "old-device", null, "DAZ-EEEE");
  f.sqlite.exec("UPDATE mobile_pairing_codes SET consumed_at='2000-01-01T00:00:00.000Z' WHERE code='DAZ-EEEE'");
  const created = await pairing.createPairingCode();
  assert.equal(pairing.isValidPairingCodeShape(created.code), true);
  // Cleanup permits the freshly generated code to reuse an expired code.
  assert.equal(f.row()?.consumed_device_id ?? null, null);
  const codes = f.sqlite.prepare("SELECT code FROM mobile_pairing_codes").all().map((r: { code: string }) => r.code);
  assert.deepEqual(codes.sort(), ["DAZ-BBBB", "DAZ-CCCC", "DAZ-DDDD", created.code].sort());
  assert.deepEqual(await pairing.checkPairingCode("DAZ-DDDD"), { status: "not_found" });
});

test("failed token clearing surfaces the database error and leaves collection retryable", async t => {
  const f = fixture(t); f.seed();
  await pairing.completePairing(input);
  f.beforeWrite(sql => {
    if (sql.startsWith("UPDATE mobile_pairing_codes")) throw new Error("synthetic database failure");
  });
  await assert.rejects(pairing.checkPairingCode(CODE), /synthetic database failure/);
  assert.equal(typeof f.row().bearer_token, "string");
  f.beforeWrite(undefined);
  assert.equal((await pairing.checkPairingCode(CODE)).status, "ready");
  assert.equal(f.row().bearer_token, null);
});
