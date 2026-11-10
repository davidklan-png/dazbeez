// Audit 2026-11-09 findings 3 + 8 — the complete statement-replacement
// contract, exercised end to end against the ACTUAL import route, parser,
// candidate-trip creation and retirement SQL on real SQLite (all migrations
// applied, PRAGMA foreign_keys=ON, db.batch = true BEGIN/COMMIT/ROLLBACK).
//
// Finding 3 (P1): the retirement DELETE of superseded AMEX lines was
// FK-blocked by business_trip_report_lines (no ON DELETE action), and the
// fresh artifact had already claimed import_status='parsed' — so the failed
// replacement left retained + new + stale charges all live while the same-SHA
// retry answered duplicate:true forever. Fix under test: retirement detaches
// only the superseded lines' trip-member links in the same batch, and 'parsed'
// is earned only after the whole replacement commits.
//
// Finding 8 (P2): retiring a superseded CONFIRMED line stranded its matched
// receipt at status='reconciled' with zero claiming lines. Fix under test: the
// retirement batch demotes only reconciled receipts with no surviving
// confirmed claim in ANY month — shared/consolidated claims and
// exported/archived/reviewed statuses survive.
//
// Harness: the audit probe pattern (operator-validation-probes.cjs) turned
// into a maintainable test — TypeScript modules loaded through a transpile
// loader with exactly two shims: @/lib/cloudflare-runtime (in-memory D1/R2)
// and @/lib/receipts/auth (fixed actor). No production module is copied or
// re-implemented here.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
// @ts-expect-error — node:sqlite is available at runtime in Node 22.5+ but
// not typed by @types/node 20 (same convention as attendee-atomic.test.ts).
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(__dirname, "..", "..");
const nodeRequire = createRequire(path.join(ROOT, "package.json"));
const ts = nodeRequire("typescript") as typeof import("typescript");

// ── Real schema + D1-shaped adapter (real FKs, real transactions) ────────────

let sqlite: DatabaseSync;

function freshDb(): void {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON"); // D1 enforces FKs
  const migrations = readdirSync(path.join(ROOT, "db/receipts"))
    .filter((n) => /^\d.*\.sql$/.test(n))
    .sort();
  for (const name of migrations) {
    sqlite.exec(readFileSync(path.join(ROOT, "db/receipts", name), "utf8"));
  }
  assert.equal(
    (sqlite.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys,
    1,
    "foreign keys must be enforced for these regressions to mean anything",
  );
}

/** Standalone statements each await a macrotask (a D1 round-trip); batch()
 * runs synchronously inside BEGIN…COMMIT and ROLLBACKs on any error — D1's
 * implicit transaction. */
function d1Adapter(): D1Database {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  function prepare(sql: string) {
    const stmt = {
      sql,
      params: [] as unknown[],
      bind(...args: unknown[]) {
        stmt.params = args;
        return stmt;
      },
      async run() {
        await tick();
        const result = sqlite.prepare(sql).run(...(stmt.params as never[]));
        return {
          success: true as const,
          meta: { changes: Number(result.changes) },
        };
      },
      async first<T>(column?: string): Promise<T | null> {
        await tick();
        const row = sqlite.prepare(sql).get(...(stmt.params as never[])) ?? null;
        return (column && row ? (row as Record<string, unknown>)[column] : row) as
          | T
          | null;
      },
      async all<T>() {
        await tick();
        return {
          results: sqlite.prepare(sql).all(...(stmt.params as never[])) as T[],
          success: true as const,
          meta: { changes: 0 },
        };
      },
    };
    return stmt;
  }
  const db = {
    prepare,
    async batch(stmts: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const r = sqlite.prepare(s.sql).run(...(s.params as never[]));
          return { success: true as const, meta: { changes: Number(r.changes) } };
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return db as unknown as D1Database;
}

// ── In-memory R2 + the two module shims ──────────────────────────────────────

const objectMap = new Map<string, Uint8Array>();
const bucket = {
  async put(key: string, data: ArrayBuffer | Uint8Array | string) {
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof ArrayBuffer
          ? new Uint8Array(data).slice()
          : data.slice();
    objectMap.set(key, bytes);
    return { key };
  },
  async get(key: string) {
    const object = objectMap.get(key);
    return object ? { body: object.slice(), size: object.length } : null;
  },
  async head(key: string) {
    const object = objectMap.get(key);
    return object ? { size: object.length } : null;
  },
  async delete(key: string) {
    objectMap.delete(key);
  },
};

let database: D1Database;
const runtime = {
  getReceiptsDb: () => database,
  getReceiptsBucket: () => bucket,
  getReceiptsArchiveBucket: () => bucket,
  getReceiptsQueue: () => null,
  getReceiptsProcessorKey: () => null,
};

// ── Transpile loader for the ACTUAL source modules ───────────────────────────

const moduleCache = new Map<string, unknown>();
function load<T>(relative: string): T {
  const cached = moduleCache.get(relative);
  if (cached) return cached as T;
  const filename = path.join(ROOT, relative);
  const source = readFileSync(filename, "utf8");
  const module_ = { exports: {} as T };
  moduleCache.set(relative, module_.exports);
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  function localRequire(name: string): unknown {
    if (name === "@/lib/cloudflare-runtime") return runtime;
    if (name === "@/lib/receipts/auth") {
      return { requireReceiptsActor: async () => "test-actor" };
    }
    if (name.startsWith("@/")) {
      const p = name.slice(2);
      return load(p + (exists(p + ".ts") ? ".ts" : ".tsx"));
    }
    if (name.startsWith("./") || name.startsWith("../")) {
      const p = path.posix.normalize(
        path.posix.join(path.posix.dirname(relative), name),
      );
      return load(p + (exists(p + ".ts") ? ".ts" : ".tsx"));
    }
    return nodeRequire(name);
  }
  function exists(p: string): boolean {
    try {
      readFileSync(path.join(ROOT, p));
      return true;
    } catch {
      return false;
    }
  }
  new Function("require", "module", "exports", js)(
    localRequire,
    module_,
    module_.exports,
  );
  return module_.exports;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

type CsvRow = [date: string, merchant: string, amount: number];

/** Netanswer-shaped CSV (same shape as the audit probe / amex-parser tests;
 *  UTF-8 like the parser tests — decodeAmexBuffer falls through to UTF-8). */
function csv(rows: CsvRow[]): File {
  const total = rows.reduce((sum, r) => sum + r[2], 0);
  const text = [
    "カード名称,TestCard",
    "お支払日,2026/11/07",
    `今回ご請求額,${total}`,
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:Test Cardholder 様,1,,,,",
    ...rows.map((r) => `${r[0]},${r[1]},1,1回,,${r[2]},`),
  ].join("\n");
  return new File([text], "SYNTHETIC.csv", { type: "text/csv" });
}

function postImport(file: File, month = "2026-11", replace = false): Promise<Response> {
  const data = new FormData();
  data.set("file", file);
  data.set("statementMonth", month);
  if (replace) data.set("replaceConfirmed", "true");
  const importer = load<{ POST: (req: Request) => Promise<Response> }>(
    "app/api/receipts/amex/import/route.ts",
  );
  return importer.POST(
    new Request("https://test.invalid/api/receipts/amex/import", {
      method: "POST",
      body: data,
    }),
  );
}

const INITIAL: CsvRow[] = [
  ["2026/10/01", "大阪 HOTEL", 1000],
  ["2026/10/02", "京都 RAIL", 2000],
];
const CORRECTION: CsvRow[] = [
  ["2026/10/01", "大阪 HOTEL", 1000],
  ["2026/10/03", "東京 STORE", 3000],
];

function q<T>(sql: string, ...args: unknown[]): T[] {
  return sqlite.prepare(sql).all(...(args as never[])) as T[];
}
function one<T>(sql: string, ...args: unknown[]): T {
  return sqlite.prepare(sql).get(...(args as never[])) as T;
}

function lineId(merchant: string): string {
  return one<{ id: string }>(
    `SELECT id FROM amex_statement_lines WHERE merchant = ?`,
    merchant,
  ).id;
}

/** Minimal receipt_records row (same column set as the audit probe). */
function insertReceipt(id: string, status: string): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO receipt_records (id, captured_at, captured_by, source, payment_path,
         transaction_date, merchant, amount_minor, currency, status,
         original_r2_key, original_sha256, original_content_type, original_size_bytes,
         created_at, updated_at)
       VALUES (?, ?, 'test', 'desktop_upload', 'AMEX', '2026-10-01', 'Test merchant', 2000, 'JPY', ?,
         'synthetic/${id}', 'sha-${id}', 'image/jpeg', 1, ?, ?)`,
    )
    .run(id, now, status, now, now);
}

function confirmClaim(lineMerchant: string, receiptId: string): void {
  sqlite
    .prepare(
      `UPDATE amex_statement_lines
       SET match_status = 'confirmed', receipt_status = 'matched', matched_receipt_id = ?
       WHERE merchant = ?`,
    )
    .run(receiptId, lineMerchant);
}

function setup(): void {
  freshDb();
  database = d1Adapter();
  objectMap.clear();
}

// ── Finding 3: parser → candidate trip → replace (retained identity) ─────────

test("replace retires FK-linked superseded lines; survivors keep identity+links; retry is an ordinary duplicate", async () => {
  setup();
  const first = await postImport(csv(INITIAL));
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = (await first.json()) as { artifactId: string; businessTripCandidates: number };
  assert.equal(firstBody.businessTripCandidates, 1, "parser→auto candidate-trip ran");
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM business_trip_report_lines`).n, 2);
  assert.equal(one<{ status: string }>(`SELECT status FROM business_trip_reports`).status, "candidate");
  const osakaId = lineId("大阪 HOTEL");

  // Pre-fix this POST died on the business_trip_report_lines FK (finding 3).
  const replace = await postImport(csv(CORRECTION), "2026-11", true);
  assert.equal(replace.status, 200, await replace.clone().text());

  // Stale charge retired; survivor keeps PK + claim-free identity, re-homed.
  assert.equal(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines WHERE merchant = '京都 RAIL'`).n,
    0,
    "superseded trip-linked line must be retired",
  );
  const osaka = one<{ id: string; statement_artifact_id: string }>(
    `SELECT id, statement_artifact_id FROM amex_statement_lines WHERE merchant = '大阪 HOTEL'`,
  );
  assert.equal(osaka.id, osakaId, "retained identity keeps its PK");
  assert.equal(osaka.statement_artifact_id, (await replace.json() as { artifactId: string }).artifactId);
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines`).n, 2);

  // Only the superseded line's trip-member link was detached; trip survives.
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM business_trip_report_lines`).n, 1);
  assert.equal(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_trip_report_lines WHERE amex_statement_line_id = ?`,
      osakaId,
    ).n,
    1,
    "survivor's trip link must survive",
  );
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM business_trip_reports`).n, 1);

  // Artifact states: old replaced, fresh earned parsed.
  const statuses = q<{ import_status: string }>(
    `SELECT import_status FROM amex_statement_artifacts ORDER BY created_at`,
  ).map((r) => r.import_status);
  assert.deepEqual(statuses, ["replaced", "parsed"]);

  // Same-SHA retry after a COMPLETE replacement is the ordinary duplicate.
  const retry = await postImport(csv(CORRECTION), "2026-11", true);
  assert.equal(retry.status, 200);
  const retryBody = (await retry.json()) as { duplicate: boolean };
  assert.equal(retryBody.duplicate, true);
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines`).n, 2);
});

// ── Finding 3: identity/amount change supersedes, not updates ────────────────

test("replace with a changed amount retires the old identity and its trip links", async () => {
  setup();
  await postImport(csv(INITIAL));
  const osakaId = lineId("大阪 HOTEL");

  const changed: CsvRow[] = [
    ["2026/10/01", "大阪 HOTEL", 1500], // amount change → new identity
    ["2026/10/03", "東京 STORE", 3000],
  ];
  const replace = await postImport(csv(changed), "2026-11", true);
  assert.equal(replace.status, 200, await replace.clone().text());

  assert.equal(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines WHERE merchant = '大阪 HOTEL' AND amount_minor = 1000`).n,
    0,
    "changed-amount old identity must be retired",
  );
  assert.equal(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines WHERE merchant = '大阪 HOTEL' AND amount_minor = 1500`).n,
    1,
  );
  assert.equal(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM business_trip_report_lines WHERE amex_statement_line_id = ?`,
      osakaId,
    ).n,
    0,
    "retired identity's trip link must be detached",
  );
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM business_trip_reports`).n, 1);
  const statuses = q<{ import_status: string }>(
    `SELECT import_status FROM amex_statement_artifacts ORDER BY created_at`,
  ).map((r) => r.import_status);
  assert.deepEqual(statuses, ["replaced", "parsed"]);
});

// ── Finding 3: failed retirement stays incomplete and heals on same-SHA retry ─

test("injected retirement failure: no parsed badge, no partial retirement, exact-SHA retry heals", async () => {
  setup();
  const first = await postImport(csv(INITIAL));
  assert.equal(first.status, 200);
  const oldArtifactId = ((await first.json()) as { artifactId: string }).artifactId;

  // Any statement failing inside the retirement batch must roll the WHOLE
  // batch back (here: a synthetic trigger on the superseded line's DELETE —
  // the same shape as the pre-fix FK violation).
  sqlite
    .exec(`CREATE TRIGGER fail_retirement BEFORE DELETE ON amex_statement_lines
           WHEN OLD.merchant = '京都 RAIL'
           BEGIN SELECT RAISE(ABORT, 'synthetic retirement failure'); END;`);
  const failed = await postImport(csv(CORRECTION), "2026-11", true);
  assert.equal(failed.status, 500);
  assert.match(((await failed.json()) as { error: string }).error, /synthetic retirement failure/);

  // Visibly incomplete: fresh artifact NOT parsed (pre-fix it already was —
  // that is what made the retry lie), old artifact not replaced, all three
  // charges live (new committed + stale not retired), trip links intact
  // (rollback undid the mid-batch detach).
  const artifacts = q<{ id: string; import_status: string }>(
    `SELECT id, import_status FROM amex_statement_artifacts ORDER BY created_at`,
  );
  assert.equal(artifacts[0]!.import_status, "parsed");
  assert.equal(artifacts[1]!.import_status, "uploaded", "parsed must be earned, not pre-labeled");
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines`).n, 3);
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM business_trip_report_lines`).n, 2);

  // Exact-SHA retry: the sha-dedup classifies 'uploaded'+lines as heal and
  // completes the retirement instead of answering a healthy duplicate.
  sqlite.exec("DROP TRIGGER fail_retirement");
  const retry = await postImport(csv(CORRECTION), "2026-11", true);
  assert.equal(retry.status, 200, await retry.clone().text());
  const retryBody = (await retry.json()) as { duplicate: boolean; message: string };
  assert.equal(retryBody.duplicate, true);
  assert.match(retryBody.message, /completed in place/);

  assert.equal(
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines WHERE merchant = '京都 RAIL'`).n,
    0,
    "retry must complete the retirement",
  );
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines`).n, 2);
  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM business_trip_report_lines`).n, 1);
  assert.equal(
    one<{ import_status: string }>(
      `SELECT import_status FROM amex_statement_artifacts WHERE id = ?`,
      oldArtifactId,
    ).import_status,
    "replaced",
  );
  assert.equal(
    one<{ import_status: string }>(
      `SELECT import_status FROM amex_statement_artifacts WHERE id != ?`,
      oldArtifactId,
    ).import_status,
    "parsed",
    "parsed is earned only after the healed retirement commits",
  );
});

// ── Finding 8: guarded last-confirmed-claim demotion ──────────────────────────

// matched_receipt_id is single-valued — each retired line claims exactly one
// receipt, so every guard case gets its OWN superseded line.
const CLAIM_MATRIX_INITIAL: CsvRow[] = [
  ["2026/10/01", "大阪 HOTEL", 1000], // retained by the correction
  ["2026/10/02", "京都 RAIL", 2000], // → orphan (only claim)
  ["2026/10/03", "神戸 TAXI", 700], // → shared (also claimed by 大阪)
  ["2026/10/04", "名古屋 BUS", 800], // → cross (also claimed by a 2026-10 line)
  ["2026/10/05", "広島 AIR", 900], // → exportedR (advanced status)
  ["2026/10/06", "千歳 RAIL", 600], // → reviewedR (non-reconciled status)
];
const CLAIM_MATRIX_CORRECTION: CsvRow[] = [
  ["2026/10/01", "大阪 HOTEL", 1000],
  ["2026/10/07", "東京 STORE", 3000],
];

test("retirement demotes only reconciled receipts with no surviving confirmed claim, and audits it", async () => {
  setup();
  await postImport(csv(CLAIM_MATRIX_INITIAL));
  // A confirmed line in ANOTHER month that must count as a surviving claim.
  await postImport(csv([["2026/09/05", "横浜 CAFE", 500]]), "2026-10");

  insertReceipt("orphan", "reconciled"); // claimed ONLY by a retired line
  insertReceipt("shared", "reconciled"); // also claimed by the surviving 大阪 line
  insertReceipt("cross", "reconciled"); // also claimed by the 2026-10 line
  insertReceipt("exportedR", "exported"); // advanced status must survive
  insertReceipt("reviewedR", "reviewed"); // non-reconciled must survive
  confirmClaim("京都 RAIL", "orphan");
  confirmClaim("神戸 TAXI", "shared");
  confirmClaim("大阪 HOTEL", "shared");
  confirmClaim("名古屋 BUS", "cross");
  confirmClaim("横浜 CAFE", "cross");
  confirmClaim("広島 AIR", "exportedR");
  confirmClaim("千歳 RAIL", "reviewedR");

  const replace = await postImport(csv(CLAIM_MATRIX_CORRECTION), "2026-11", true);
  assert.equal(replace.status, 200, await replace.clone().text());

  const status = (id: string) =>
    one<{ status: string }>(`SELECT status FROM receipt_records WHERE id = ?`, id).status;
  assert.equal(status("orphan"), "needs_review", "last confirmed claim retired → back to review");
  assert.equal(status("shared"), "reconciled", "surviving same-month confirmed claim → keep");
  assert.equal(status("cross"), "reconciled", "surviving other-month confirmed claim → keep");
  assert.equal(status("exportedR"), "exported", "exported status must survive");
  assert.equal(status("reviewedR"), "reviewed", "non-reconciled status must survive");
  assert.equal(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM amex_statement_lines WHERE matched_receipt_id = 'orphan'`,
    ).n,
    0,
    "orphan has zero claiming lines",
  );
  assert.equal(
    one<{ matched_receipt_id: string }>(
      `SELECT matched_receipt_id FROM amex_statement_lines WHERE merchant = '大阪 HOTEL'`,
    ).matched_receipt_id,
    "shared",
    "survivor's claim survives the re-home",
  );

  // One audit entry records the retirement AND the guarded demotion.
  const audits = q<{ new_value_json: string }>(
    `SELECT new_value_json FROM receipt_audit_log
     WHERE action = 'amex_statement.replaced_artifact_lines_deleted'`,
  );
  assert.equal(audits.length, 1);
  const payload = JSON.parse(audits[0]!.new_value_json) as {
    demotedReceiptIds: string[];
    replacedArtifacts: { deletedTripMemberLinks: number }[];
  };
  assert.deepEqual(payload.demotedReceiptIds, ["orphan"]);
  assert.ok(
    payload.replacedArtifacts.some((a) => a.deletedTripMemberLinks > 0),
    "trip-link detach is audited",
  );
});

// ── Control: all identities retained → nothing retired, links survive ────────

test("replace retaining every identity succeeds with links and statuses intact", async () => {
  setup();
  await postImport(csv(INITIAL));
  const osakaId = lineId("大阪 HOTEL");
  const kyotoId = lineId("京都 RAIL");

  const superset: CsvRow[] = [...INITIAL, ["2026/10/03", "東京 STORE", 3000]];
  const replace = await postImport(csv(superset), "2026-11", true);
  assert.equal(replace.status, 200, await replace.clone().text());

  assert.equal(one<{ n: number }>(`SELECT COUNT(*) AS n FROM amex_statement_lines`).n, 3);
  assert.equal(lineId("大阪 HOTEL"), osakaId, "identity retained");
  assert.equal(lineId("京都 RAIL"), kyotoId, "identity retained");
  const newArtifactId = ((await replace.json()) as { artifactId: string }).artifactId;
  for (const id of [osakaId, kyotoId]) {
    assert.equal(
      one<{ statement_artifact_id: string }>(
        `SELECT statement_artifact_id FROM amex_statement_lines WHERE id = ?`,
        id,
      ).statement_artifact_id,
      newArtifactId,
    );
    assert.equal(
      one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM business_trip_report_lines WHERE amex_statement_line_id = ?`,
        id,
      ).n,
      1,
      "retained identity keeps its trip link",
    );
  }
});
