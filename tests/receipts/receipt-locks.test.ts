import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error node:sqlite is present in the project test runtime.
import { DatabaseSync } from "node:sqlite";
import { computeReceiptLocks, getReceiptLocks, loadReceiptClaimLocks, type ReceiptLockD1 } from "@/lib/receipts/receipt-locks";
import { rejectIfReceiptInFinalizedReconciliation } from "@/lib/receipts/db";
import { isMonthLockedForEdits } from "@/lib/receipts/month-lock";
import { buildQueueItems } from "@/lib/receipts/queue-items";
import { filterReviewQueue } from "@/lib/receipts/review-queue-filter";
import { D1_ID_CHUNK_SIZE } from "@/lib/receipts/db-utils";
import type { PaymentPath, ReceiptRecord } from "@/lib/receipts/types";

const paths: PaymentPath[] = ["AMEX", "CASH", "DIGITAL", "UNKNOWN"];
function fixture(path: PaymentPath = "CASH", overrides: Partial<ReceiptRecord> = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(`db/receipts/${file}`, "utf8"));
  }
  raw.prepare(`INSERT INTO receipt_records
    (id,captured_at,captured_by,payment_path,transaction_date,merchant,amount_minor,currency,status,
     original_r2_key,original_sha256,original_content_type,original_size_bytes,created_at,updated_at)
    VALUES ('r','t','fixture',?,'2026-05-10','Fixture',100,'JPY','reviewed','k','s','image/jpeg',1,'t','t')`).run(path);
  for (const [key, value] of Object.entries(overrides).sort(([a], [b]) => Number(a === "status") - Number(b === "status"))) {
    raw.prepare(`UPDATE receipt_records SET ${key}=? WHERE id='r'`).run(value);
  }
  // Real emitted D1 queries and actual server prechecks, executed by SQLite.
  const db = { prepare(sql: string) {
    let args: unknown[] = [];
    const query = {
      bind(...values: unknown[]) { args = values; return query; },
      async all() { return { results: raw.prepare(sql).all(...args) }; },
      async first() { return raw.prepare(sql).get(...args) ?? null; },
    };
    return query;
  } } as unknown as D1Database;
  function exp(month: string, draft = false) {
    const id = `${month}-${draft}`;
    raw.prepare(`INSERT INTO receipt_exports
      (id,export_month,status,created_by,created_at,retention_until,legal_hold,export_revision)
      VALUES (?,?,'draft','fixture','t','t',1,?)`).run(id, month, draft ? 2 : 1);
    if (!draft) raw.prepare("UPDATE receipt_exports SET status='finalized' WHERE id=?").run(id);
    return id;
  }
  function published(month: string) {
    raw.prepare(`INSERT INTO receipt_exports (id,export_month,status,created_by,created_at,retention_until,legal_hold)
      VALUES (?,?,'draft','fixture','t','t',1)`).run(month, month);
    raw.prepare(`INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at)
      VALUES (?,?,'receipt','r','t')`).run(month, month);
    raw.prepare("UPDATE receipt_exports SET status='finalized' WHERE id=?").run(month);
  }
  function recon(month: string) {
    raw.prepare(`INSERT INTO amex_statement_lines
      (id,statement_month,transaction_date,merchant,amount_minor,currency,match_status,raw_json,created_at,matched_receipt_id)
      VALUES (?,?,'2026-05-10','Fixture',100,'JPY','matched','{}','t','r')`).run(month, month);
    raw.prepare(`INSERT INTO amex_reconciliations (id,statement_month,status,line_count,matched_count,no_receipt_count,created_by,created_at)
      VALUES (?,?,'finalized',1,1,0,'fixture','t')`).run(month, month);
  }
  async function lock() {
    const row = raw.prepare("SELECT * FROM receipt_records WHERE id='r'").get() as ReceiptRecord;
    const locks = await getReceiptLocks([row], db);
    // Verify downstream queue data/filter consumes the real authority result.
    assert.equal(buildQueueItems([row], new Map(), Date.now(), locks)[0].locked, locks.get("r")!.locked);
    assert.equal(filterReviewQueue([row], "", { locks }).length, locks.get("r")!.locked ? 0 : 1);
    return locks.get("r")!;
  }
  function sqlRefused(locked: boolean) {
    const edit = () => raw.prepare("UPDATE receipt_records SET amount_minor=amount_minor+1 WHERE id='r'").run();
    if (locked) assert.throws(edit, /DZ_SEAL_MONTH_LOCKED/);
    else assert.doesNotThrow(edit);
  }
  return { raw, db, exp, published, recon, lock, sqlRefused };
}

for (const path of paths) {
  test(`${path}: May receipt / July finalized reconciliation; actual server + SQL + queue parity`, async () => {
    const f = fixture(path);
    try {
      f.recon("2026-07");
      // A finalized reconciliation alone is not an export edit lock.
      assert.equal((await f.lock()).locked, false);
      await rejectIfReceiptInFinalizedReconciliation(f.db, "r");
      f.sqlRefused(false);
      f.exp("2026-07");
      assert.equal(await isMonthLockedForEdits(f.db, "2026-07"), true);
      assert.deepEqual(await f.lock(), { locked: true, kind: "reconciliation", month: "2026-07" });
      await assert.rejects(rejectIfReceiptInFinalizedReconciliation(f.db, "r"), /finalized reconciliation/);
      f.sqlRefused(true);
      f.exp("2026-05", true); // unrelated correction cannot release July
      assert.equal((await f.lock()).month, "2026-07");
      f.sqlRefused(true);
      f.exp("2026-07", true);
      assert.equal((await f.lock()).locked, false);
      await rejectIfReceiptInFinalizedReconciliation(f.db, "r");
      f.sqlRefused(false);
      assert.throws(() => f.raw.prepare("UPDATE amex_statement_lines SET amount_minor=9 WHERE id='2026-07'").run(), /DZ_SEAL_RECON_LOCKED/);
    } finally { f.raw.close(); }
  });

  for (const claim of ["published", "exported_month"] as const) {
    test(`${path}: ${claim} alone locks May/July even undated and status-independent`, async () => {
      const f = fixture(path, { transaction_date: null, ...(claim === "exported_month" ? { exported_month: "2026-07" } : {}) });
      try {
        if (claim === "published") f.published("2026-07"); else f.exp("2026-07");
        assert.deepEqual(await f.lock(), { locked: true, kind: "export", month: "2026-07" });
        f.sqlRefused(true);
        f.exp("2026-05", true);
        assert.equal((await f.lock()).locked, true);
        f.exp("2026-07", true);
        assert.equal((await f.lock()).locked, false);
        f.sqlRefused(false);
      } finally { f.raw.close(); }
    });
  }
}

for (const path of ["CASH", "DIGITAL"] as const) {
  test(`${path}: sticky July and calendar May independently retain closed claims`, async () => {
    const f = fixture(path, { export_statement_month: "2026-07" });
    try {
      f.exp("2026-05"); f.exp("2026-07");
      assert.equal((await f.lock()).month, "2026-07");
      f.sqlRefused(true);
      f.exp("2026-07", true);
      assert.equal((await f.lock()).month, "2026-05");
      f.sqlRefused(true);
      f.exp("2026-05", true);
      assert.equal((await f.lock()).locked, false);
      f.sqlRefused(false);
    } finally { f.raw.close(); }
  });
}

for (const path of ["CASH", "DIGITAL"] as const) {
  test(`${path}: an undated sticky claim stays locked until its own correction opens`, async () => {
    const f = fixture(path, { transaction_date: null, export_statement_month: "2026-07" });
    try {
      f.exp("2026-07");
      assert.deepEqual(await f.lock(), { locked: true, kind: "export", month: "2026-07" });
      f.sqlRefused(true);
      f.exp("2026-05", true);
      assert.equal((await f.lock()).locked, true);
      f.exp("2026-07", true);
      assert.equal((await f.lock()).locked, false);
      f.sqlRefused(false);
    } finally { f.raw.close(); }
  });
}

test("competing published/reconciliation months choose a stable concrete reason; one draft releases only itself", async () => {
  const f = fixture("DIGITAL");
  try {
    f.published("2026-08"); f.published("2026-07");
    assert.equal((await f.lock()).month, "2026-07");
    f.exp("2026-07", true);
    assert.equal((await f.lock()).month, "2026-08");
    f.sqlRefused(true);
    f.recon("2026-09"); f.recon("2026-06");
    f.exp("2026-09"); f.exp("2026-06");
    assert.deepEqual(await f.lock(), { locked: true, kind: "reconciliation", month: "2026-06" });
    f.exp("2026-06", true);
    assert.equal((await f.lock()).month, "2026-09");
    f.sqlRefused(true);
    f.exp("2026-09", true); f.exp("2026-08", true);
    assert.equal((await f.lock()).locked, false);
    f.sqlRefused(false);
  } finally { f.raw.close(); }
});

test("archived stays terminal under correction; exported without a recorded month stays read-only", async () => {
  for (const path of paths) {
    const f = fixture(path, { status: "archived", exported_month: "2026-07" });
    try {
      f.exp("2026-07"); f.exp("2026-07", true);
      assert.deepEqual(await f.lock(), { locked: true, kind: "archived", month: "2026-07" });
      f.sqlRefused(true);
    } finally { f.raw.close(); }
    const row = { id: "r", payment_path: path, status: "exported", transaction_date: null } as ReceiptRecord;
    assert.deepEqual(computeReceiptLocks([row], new Set(), new Map()).get("r"), { locked: true, kind: "exported", month: null });
  }
});

test("exported status with a known unsealed/correction month follows the existing route predicate", async () => {
  const f = fixture("AMEX", { status: "exported", exported_month: "2026-07" });
  try {
    assert.equal((await f.lock()).locked, false);
    f.exp("2026-07"); assert.equal((await f.lock()).locked, true);
    f.exp("2026-07", true); assert.equal((await f.lock()).locked, false);
    f.sqlRefused(false);
  } finally { f.raw.close(); }
});

test("existing calendar policy: UNKNOWN locked, unmatched AMEX and undated CASH unlocked", () => {
  const rows = paths.map((payment_path) => ({ id: payment_path, payment_path, transaction_date: "2026-05-10" }) as ReceiptRecord);
  const locks = computeReceiptLocks(rows, new Set(["2026-05"]), new Map());
  for (const path of paths) assert.equal(locks.get(path)?.locked, path !== "AMEX");
  assert.equal(computeReceiptLocks([{ id: "r", payment_path: "CASH", transaction_date: null } as ReceiptRecord], new Set(["2026-05"]), new Map()).get("r")?.locked, false);
});

test("batched claims stay within D1 bind limits and empty inputs perform no queries", async () => {
  const bindCounts: number[] = [];
  const db: ReceiptLockD1 = { prepare() { return { bind(...args) {
    bindCounts.push(args.length); return { all: async () => ({ results: [] }) };
  } }; } };
  assert.equal((await loadReceiptClaimLocks(db, [])).size, 0);
  assert.equal(bindCounts.length, 0);
  await loadReceiptClaimLocks(db, Array.from({ length: D1_ID_CHUNK_SIZE + 5 }, (_, i) => `r${i}`));
  assert.deepEqual(bindCounts, [D1_ID_CHUNK_SIZE, D1_ID_CHUNK_SIZE, 5, 5]);
});
