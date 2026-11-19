import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
// @ts-expect-error node:sqlite is available in Node22; repository uses @types/node20.
import { DatabaseSync } from "node:sqlite";
const root = path.resolve(__dirname, "../../..");
const requireNode = createRequire(path.join(root, "package.json"));
const ts = requireNode("typescript") as typeof import("typescript");

/** Actual source, full migration chain, FKs, and real D1 batch rollback. */
export function amexFixture(recursive = false, beforeRevision?: (sql: DatabaseSync) => void) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=${recursive ? "ON" : "OFF"}`);
  for (const f of readdirSync(path.join(root, "db/receipts")).filter(f => /^\d.*\.sql$/.test(f)).sort()) {
    if (f.startsWith("0048")) beforeRevision?.(sql);
    sql.exec(readFileSync(path.join(root, "db/receipts", f), "utf8"));
  }
  let beforeBatch: (() => void) | undefined;
  let afterBatch: (() => void) | undefined;
  function prepare(query: string) {
    const stmt = { query, params: [] as unknown[],
      bind(...params: unknown[]) { stmt.params = params; return stmt; },
      async run() { const r = sql.prepare(query).run(...stmt.params); return { success: true, meta: { changes: Number(r.changes) } }; },
      async first(column?: string) { const r = sql.prepare(query).get(...stmt.params) ?? null; return column && r ? r[column] : r; },
      async all() { return { success: true, results: sql.prepare(query).all(...stmt.params), meta: { changes: 0 } }; },
    };
    return stmt;
  }
  const db = { prepare, async batch(stmts: ReturnType<typeof prepare>[]) {
    const before = beforeBatch; beforeBatch = undefined; before?.();
    sql.exec("BEGIN");
    let out;
    try {
      out = stmts.map(s => {
        const st = sql.prepare(s.query);
        if (/^\s*(SELECT|WITH)/i.test(s.query)) return { success: true, results: st.all(...s.params), meta: { changes: 0 } };
        const r = st.run(...s.params); return { success: true, results: [], meta: { changes: Number(r.changes) } };
      });
      sql.exec("COMMIT");
    } catch (err) { sql.exec("ROLLBACK"); throw err; }
    const after = afterBatch; afterBatch = undefined; after?.();
    return out;
  } } as unknown as D1Database;
  const cache = new Map<string, { exports: unknown }>();
  function load<T>(relative: string): T {
    if (cache.has(relative)) return cache.get(relative)!.exports as T;
    const m = { exports: {} as unknown }; cache.set(relative, m);
    const js = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const localRequire = (name: string): unknown => {
      if (name === "@/lib/cloudflare-runtime") return { getReceiptsDb: () => db };
      if (name === "@/lib/receipts/auth") return { requireReceiptsActor: async (headers: Headers) => {
        if (headers?.get("x-test-deny")) throw new Error("Unauthorized"); return "fixture";
      } };
      if (name.startsWith("@/") || name.startsWith(".")) {
        const p = name.startsWith("@/") ? name.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
        return load(p + (existsSync(path.join(root, p + ".ts")) ? ".ts" : ".tsx"));
      }
      return requireNode(name);
    };
    new Function("require", "module", "exports", js)(localRequire, m, m.exports);
    return m.exports as T;
  }
  const writers = load<typeof import("@/lib/receipts/db")>("lib/receipts/db.ts");
  const patchRoute = load<typeof import("@/app/api/receipts/amex/lines/[id]/route")>("app/api/receipts/amex/lines/[id]/route.ts");
  const reconcileRoute = load<typeof import("@/app/api/receipts/reconcile/route")>("app/api/receipts/reconcile/route.ts");
  const tripRoute = load<typeof import("@/app/api/receipts/trips/[id]/route")>("app/api/receipts/trips/[id]/route.ts");
  const memberRoute = load<typeof import("@/app/api/receipts/trips/[id]/members/route")>("app/api/receipts/trips/[id]/members/route.ts");
  function request(body: unknown, method = "PATCH", deny = false) {
    return new Request("https://fixture.invalid", { method, headers: { "Content-Type": "application/json", ...(deny ? { "x-test-deny": "1" } : {}) }, body: JSON.stringify(body) });
  }
  const get = (query: string, ...params: unknown[]) => sql.prepare(query).get(...params) as Record<string, string | number | null>;
  const all = (query: string, ...params: unknown[]) => sql.prepare(query).all(...params) as Record<string, string | number | null>[];
  const revision = (id = "l") => get("SELECT revision FROM amex_line_revisions WHERE line_id = ?", id)?.revision as number;
  const tripRevision = (id = "t") => get("SELECT revision FROM business_trip_reports WHERE id = ?", id)?.revision as number;
  function line(id = "l", receipt: string | null = null, status = "unmatched", month = "2026-11") {
    sql.prepare(`INSERT INTO amex_statement_lines(id, statement_month, transaction_date, merchant, amount_minor, raw_json, created_at, matched_receipt_id, match_status)
      VALUES (?, ?, '2026-11-01', 'AMEX merchant', 100, '{}', 'same-ms', ?, ?)`).run(id, month, receipt, status);
  }
  function receipt(id = "r", status = "reviewed", payment = "UNKNOWN") {
    sql.prepare(`INSERT INTO receipt_records(id,captured_at,captured_by,source,payment_path,merchant,amount_minor,status,original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at)
      VALUES (?,'t','fixture','desktop_upload',?,'Old receipt',100,?,?,'hash','image/png',1,'t','t')`).run(id, payment, status, id);
  }
  function trip(id = "t") { sql.prepare(`INSERT INTO business_trip_reports(id,cardholder_name,start_date,end_date,created_at,updated_at) VALUES (?,'Fixture','2026-11-01','2026-11-02','t','t')`).run(id); }
  function seal(month = "2026-11") { sql.prepare(`INSERT INTO amex_reconciliations(id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at) VALUES (?,?,'finalized',1,0,0,'fixture','t')`).run("seal-" + month, month); }
  const auditCount = () => get("SELECT count(*) n FROM receipt_audit_log").n;
  return { sql, db, writers, get, all, revision, tripRevision, line, receipt, trip, seal, auditCount, load,
    beforeBatch(fn: () => void) { beforeBatch = fn; }, afterBatch(fn: () => void) { afterBatch = fn; },
    patch: (id: string, body: unknown, deny = false) => patchRoute.PATCH(request(body, "PATCH", deny), { params: Promise.resolve({ id }) }),
    reconcile: (body: unknown) => reconcileRoute.POST(request(body, "POST")),
    patchTrip: (id: string, body: unknown) => tripRoute.PATCH(request(body), { params: Promise.resolve({ id }) }),
    members: (id: string, body: unknown, attach = true) => memberRoute[attach ? "POST" : "DELETE"](request(body, attach ? "POST" : "DELETE"), { params: Promise.resolve({ id }) }),
  };
}
