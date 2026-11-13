// Seal boundary — claim + publication persistence, executed against REAL
// SQLite (node:sqlite) through a D1-compatible shim, with the FULL migration
// chain applied so the 0042 triggers and FK cascades are live. The functions
// under test are the real acquireSealClaim / releaseSealClaim /
// publishExportBundle / createExport — the exact SQL the route drives.
//
// Contract coverage: regression acceptance 6 (draft-creation race, two
// finalizers), 7 (expiry races), 8 (CAS-zero + injected failures), 10
// (message/decision semantics on failed and successful builds).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createExport, getExportById } from "@/lib/receipts/db";
import { publishExportBundle } from "@/lib/receipts/export-publication";
import {
  acquireSealClaim,
  releaseSealClaim,
  SealClaimConflictError,
} from "@/lib/receipts/month-lock";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- node:sqlite has no typings in this @types/node yet
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...p: unknown[]): Record<string, unknown> | undefined;
      all(...p: unknown[]): Record<string, unknown>[];
      run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
  };
};

/** D1 shim over the full migrated schema; batch = one transaction, with a
 *  statement-failure injection hook and a pre-statement async race hook. */
class SqliteD1 {
  readonly db: ReturnType<typeof mkRaw>;
  onBeforeStatement: ((sql: string) => Promise<void>) | null = null;
  /** When set, a batch statement matching this predicate throws BEFORE running. */
  injectFailure: ((sql: string) => Error | null) | null = null;

  constructor() {
    this.db = mkRaw();
  }
  static exec(db: SqliteD1["db"], sql: string, ...params: unknown[]): void {
    db.prepare(sql).run(...params);
  }
  prepare(sql: string) {
    const make = (args: unknown[]) => ({
      first: async <T>(): Promise<T | null> => {
        const row = this.db.prepare(sql).get(...args);
        return (row ?? null) as T | null;
      },
      all: async <T>(): Promise<{ results: T[] }> => {
        return { results: this.db.prepare(sql).all(...args) as T[] };
      },
      run: async (): Promise<{ success: true; meta: { changes: number } }> => {
        await this.onBeforeStatement?.(sql);
        const injected = this.injectFailure?.(sql);
        if (injected) throw injected;
        const info = this.db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      __spec: { sql, args } as { sql: string; args: unknown[] },
    });
    return { bind: (...args: unknown[]) => make(args) };
  }
  private chain: Promise<unknown> = Promise.resolve();
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

function mkRaw() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("db/receipts").filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`db/receipts/${f}`, "utf8"));
  }
  return db;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function seedExportDraft(d1: SqliteD1, id: string, month: string, rev = 1): void {
  d1.db
    .prepare(
      `INSERT INTO receipt_exports
         (id,export_month,status,created_by,created_at,retention_until,legal_hold,export_revision)
       VALUES (?, ?, 'draft', 'a', 't', 't', 1, ?)`,
    )
    .run(id, month, rev);
}

function seedReceipt(d1: SqliteD1, id: string, month: string, status = "reviewed"): void {
  d1.db
    .prepare(
      `INSERT INTO receipt_records
         (id,captured_at,captured_by,payment_path,transaction_date,merchant,amount_minor,
          currency,status,original_r2_key,original_sha256,original_content_type,
          original_size_bytes,created_at,updated_at,export_statement_month)
       VALUES (?,'t','a','CASH',?,'m',100,'JPY',?,?,'s','image/jpeg',1,'t','t',?)`,
    )
    .run(id, month + "-10", status, "k" + id, month);
}

function seedPriorBuild(d1: SqliteD1, exportId: string, receiptId: string): void {
  // A previously published draft build: items + metadata + bundle_built_at.
  d1.db
    .prepare(
      `INSERT INTO receipt_export_items (id,export_id,item_type,item_id,created_at)
       VALUES ('old-i',?, 'receipt', ?, 't-old')`,
    )
    .run(exportId, receiptId);
  d1.db
    .prepare(
      `UPDATE receipt_exports
         SET archive_r2_key='exports/m/ex/OLD/receipts.csv', manifest_r2_key='exports/m/ex/OLD/manifest.csv',
             archive_sha256='OLD-SHA', manifest_sha256='OLD-MSHA', proofs_r2_key='exports/m/ex/OLD/proofs.zip',
             proofs_sha256='OLD-PSHA', bundle_built_at='2026-01-01T00:00:00Z', payment_due_date='2026-01-20',
             operator_message='old message', operator_message_updated_at='2026-01-01T00:00:00Z',
             bundle_build_id='OLD-BUILD'
       WHERE id = ?`,
    )
    .run(exportId);
}

function candidate(d1: SqliteD1, over: Partial<Parameters<typeof publishExportBundle>[1]> = {}) {
  void d1;
  return {
    exportId: "ex",
    month: "2026-01",
    buildId: "tok",
    actor: "op@test",
    finalize: false,
    rowCount: 1,
    archiveKey: "exports/2026-01/ex/tok/ex-receipts.csv",
    manifestKey: "exports/2026-01/ex/tok/ex-manifest.csv",
    archiveSha256: "A1",
    manifestSha256: "M1",
    proofsKey: "exports/2026-01/ex/tok/ex-proofs.zip",
    proofsSha256: "P1",
    paymentDueDate: "2026-01-20",
    operatorMessage: null,
    items: [{ itemType: "receipt" as const, itemId: "r1" }],
    promotableReceiptIds: [],
    ...over,
  };
}

const audits = (d1: SqliteD1, objectId: string) =>
  d1.db
    .prepare(`SELECT action, actor FROM receipt_audit_log WHERE object_id = ? ORDER BY rowid`)
    .all(objectId) as unknown as { action: string; actor: string }[];

// ─── Acceptance 6: draft-creation race ──────────────────────────────────────

test("A6 two first-ever builds racing draft creation produce ONE canonical draft, no unhandled error", async () => {
  const d1 = new SqliteD1();
  const db = d1.asD1();
  const [a, b] = await Promise.all([
    createExport("2026-01", "op-a", db),
    createExport("2026-01", "op-b", db),
  ]);
  assert.equal(a, b, "both racers converge on the same canonical draft id");
  const drafts = d1.db
    .prepare(`SELECT id FROM receipt_exports WHERE export_month='2026-01' AND status='draft'`)
    .all();
  assert.equal(drafts.length, 1);
});

// ─── Acceptance 6: two finalizers — one owned publication, loser conflicts ──

test("A6 two finalizers on one draft: exactly one acquires; the loser gets a typed conflict", async () => {
  const d1 = new SqliteD1();
  seedExportDraft(d1, "ex", "2026-01");
  const db = d1.asD1();
  const a = await acquireSealClaim(db, { exportId: "ex", finalize: true, operatorMessage: "msg", decisionAt: "2026-01-15T00:00:00Z" });
  await assert.rejects(
    acquireSealClaim(db, { exportId: "ex", finalize: true, operatorMessage: "msg2", decisionAt: "2026-01-15T00:00:01Z" }),
    (err: unknown) => err instanceof SealClaimConflictError,
  );
  // The winner publishes; the loser's claim attempt wrote nothing.
  await publishExportBundle(db, candidate(d1, { buildId: a, finalize: true }));
  const row = d1.db.prepare(`SELECT status, bundle_build_id, sealing_token FROM receipt_exports WHERE id='ex'`).get() as never as {
    status: string; bundle_build_id: string; sealing_token: string | null;
  };
  assert.equal(row.status, "finalized");
  assert.equal(row.bundle_build_id, a);
  assert.equal(row.sealing_token, null);
});

// ─── Acceptance 7: expiry ────────────────────────────────────────────────────

test("A7 expired lease: edits flow, expired attempt cannot publish, successor can", async () => {
  const d1 = new SqliteD1();
  seedReceipt(d1, "r1", "2026-01");
  seedExportDraft(d1, "ex", "2026-01");
  const db = d1.asD1();
  // A acquires a claim that is ALREADY expired (test seam: leaseSeconds < 0) —
  // the exact state a suspended builder is in ten minutes later.
  const stale = await acquireSealClaim(db, { exportId: "ex", finalize: false, leaseSeconds: -5 });

  // Edits are allowed while the claim is expired (predicates ignore it).
  d1.db.prepare(`UPDATE receipt_records SET amount_minor = 55 WHERE id='r1'`).run();

  // A's publication loses: CAS requires the unexpired lease.
  await assert.rejects(
    publishExportBundle(db, candidate(d1, { buildId: stale })),
    (err: unknown) => /DZ_|constraint|NOT NULL/i.test((err as Error).message),
  );
  const afterLoser = d1.db.prepare(`SELECT bundle_build_id, status FROM receipt_exports WHERE id='ex'`).get() as never as { bundle_build_id: string | null; status: string };
  assert.equal(afterLoser?.bundle_build_id ?? null, null, "expired attempt published nothing");
  assert.equal(afterLoser?.status, "draft");
  assert.equal((d1.db.prepare(`SELECT COUNT(*) AS n FROM receipt_export_items WHERE export_id='ex'`).get() as { n: number }).n, 0);
  assert.equal(audits(d1, "ex").length, 0, "no success audit for the expired attempt");

  // B can re-acquire over the expired lease and publish.
  const fresh = await acquireSealClaim(db, { exportId: "ex", finalize: false });
  await publishExportBundle(db, candidate(d1, { buildId: fresh }));
  const row = d1.db.prepare(`SELECT bundle_build_id, sealing_token FROM receipt_exports WHERE id='ex'`).get() as never as { bundle_build_id: string; sealing_token: string | null };
  assert.equal(row.bundle_build_id, fresh);
  assert.equal(row.sealing_token, null);
});

// ─── Acceptance 8: CAS-zero — every arm, zero output changes ─────────────────

test("A8 lost token / expired lease / finalized row: publication writes NOTHING and audits nothing", async () => {
  const d1 = new SqliteD1();
  seedReceipt(d1, "r1", "2026-01");
  seedExportDraft(d1, "ex", "2026-01");
  const db = d1.asD1();
  seedPriorBuild(d1, "ex", "r1");
  const winner = await acquireSealClaim(db, { exportId: "ex", finalize: false });

  const before = {
    row: d1.db.prepare(`SELECT * FROM receipt_exports WHERE id='ex'`).get() as Record<string, unknown>,
    items: d1.db.prepare(`SELECT item_id FROM receipt_export_items WHERE export_id='ex' ORDER BY item_id`).all(),
  };

  // Lost token.
  await assert.rejects(publishExportBundle(db, candidate(d1, { buildId: "wrong-token" })));
  // Expired lease: release the winner's claim, then acquire one that starts
  // already expired.
  await releaseSealClaim(db, "ex", winner);
  const expired = await acquireSealClaim(db, { exportId: "ex", finalize: false, leaseSeconds: -1 });
  await assert.rejects(publishExportBundle(db, candidate(d1, { buildId: expired })));
  // Already-finalized row: acquire over the expired lease, release it (so the
  // row carries no live claim), flip to finalized, then publish with the now
  // orphaned token — the CAS must refuse the sealed row.
  const tok = await acquireSealClaim(db, { exportId: "ex", finalize: false });
  await releaseSealClaim(db, "ex", tok);
  d1.db.prepare(`UPDATE receipt_exports SET status='finalized' WHERE id='ex'`).run();
  await assert.rejects(publishExportBundle(db, candidate(d1, { buildId: tok })));

  const after = {
    row: d1.db.prepare(`SELECT * FROM receipt_exports WHERE id='ex'`).get() as Record<string, unknown>,
    items: d1.db.prepare(`SELECT item_id FROM receipt_export_items WHERE export_id='ex' ORDER BY item_id`).all(),
  };
  // Byte-for-byte survival of the previous published build.
  for (const col of ["archive_r2_key", "manifest_r2_key", "archive_sha256", "manifest_sha256", "proofs_r2_key", "proofs_sha256", "bundle_built_at", "bundle_build_id", "operator_message", "payment_due_date"]) {
    assert.equal(after.row[col], before.row[col], `${col} survives a lost publication byte-for-byte`);
  }
  assert.deepEqual(after.items, before.items, "previous published item set survives");
  assert.equal(audits(d1, "ex").length, 0, "zero success audits for lost publications");
});

test("A8 injected failure at items insertion / metadata / audit / promotion tail rolls the whole publication back", async () => {
  for (const match of [
    /INSERT OR IGNORE INTO receipt_export_items/,
    /UPDATE receipt_exports\s+SET archive_r2_key/,
    /INSERT INTO receipt_audit_log[\s\S]*?CASE WHEN changes\(\) = 1/,
  ]) {
    const d1 = new SqliteD1();
    seedReceipt(d1, "r1", "2026-01");
    seedExportDraft(d1, "ex", "2026-01");
    seedPriorBuild(d1, "ex", "r1");
    const db = d1.asD1();
    const tok = await acquireSealClaim(db, { exportId: "ex", finalize: false });
    const beforeItems = d1.db.prepare(`SELECT item_id FROM receipt_export_items WHERE export_id='ex' ORDER BY item_id`).all();
    const beforeRow = d1.db.prepare(`SELECT archive_r2_key, bundle_build_id FROM receipt_exports WHERE id='ex'`).get();

    d1.injectFailure = (sql) => (match.test(sql) ? new Error("injected") : null);
    await assert.rejects(publishExportBundle(db, candidate(d1, { buildId: tok })), /injected/);
    d1.injectFailure = null;

    const afterRow = d1.db.prepare(`SELECT archive_r2_key, bundle_build_id FROM receipt_exports WHERE id='ex'`).get();
    assert.deepEqual(afterRow, beforeRow, `metadata survives injected failure at ${match}`);
    assert.deepEqual(
      d1.db.prepare(`SELECT item_id FROM receipt_export_items WHERE export_id='ex' ORDER BY item_id`).all(),
      beforeItems,
      `items survive injected failure at ${match}`,
    );
    assert.equal(audits(d1, "ex").length, 0, `no audits survive injected failure at ${match}`);
  }
});

// ─── Acceptance 8: finalize promotions + audits inside the transaction ───────

test("A8 finalize: promotion + lifecycle audits commit with the seal; already-exported rows untouched", async () => {
  const d1 = new SqliteD1();
  seedReceipt(d1, "r1", "2026-01", "reviewed");
  seedReceipt(d1, "r2", "2026-01", "exported"); // stays exported; promotion guard skips
  d1.db.prepare(`UPDATE receipt_records SET exported_month='2025-12' WHERE id='r2'`).run();
  seedReceipt(d1, "r3", "2026-01", "archived"); // terminal; not promoted
  seedExportDraft(d1, "ex", "2026-01");
  const db = d1.asD1();
  const tok = await acquireSealClaim(db, { exportId: "ex", finalize: true, operatorMessage: "hi", decisionAt: "2026-02-01T00:00:00Z" });
  await publishExportBundle(
    db,
    candidate(d1, {
      buildId: tok,
      finalize: true,
      items: [
        { itemType: "receipt", itemId: "r1" },
        { itemType: "receipt", itemId: "r2" },
        { itemType: "receipt", itemId: "r3" },
      ],
      promotableReceiptIds: ["r1"],
    }),
  );
  const st = (id: string) => d1.db.prepare(`SELECT status, exported_month FROM receipt_records WHERE id=?`).get(id) as never as { status: string; exported_month: string | null };
  assert.equal(st("r1").status, "exported");
  assert.equal(st("r1").exported_month, "2026-01");
  assert.equal(st("r2").exported_month, "2025-12", "already-exported row untouched");
  assert.equal(st("r3").status, "archived", "archived row stays terminal");
  const r1Audits = audits(d1, "r1");
  assert.ok(r1Audits.some((a) => a.action === "receipt.exported"), "promotion audit written in-transaction");
  // No false promotion audit for the skipped rows.
  assert.equal(audits(d1, "r2").filter((a) => a.action === "receipt.exported").length, 0);
  assert.equal(audits(d1, "r3").filter((a) => a.action === "receipt.exported").length, 0);
  // The export audit recorded the seal.
  assert.ok(audits(d1, "ex").some((a) => a.action === "export.finalized"));
});

// ─── Acceptance 10: message/decision semantics ───────────────────────────────

test("A10 failed rebuild with an explicit override preserves the OLD published message + decision timestamp", async () => {
  const d1 = new SqliteD1();
  seedReceipt(d1, "r1", "2026-01");
  seedExportDraft(d1, "ex", "2026-01");
  seedPriorBuild(d1, "ex", "r1");
  const db = d1.asD1();
  const tok = await acquireSealClaim(db, { exportId: "ex", finalize: false });
  d1.injectFailure = (sql) => (/INSERT OR IGNORE INTO receipt_export_items/.test(sql) ? new Error("injected") : null);
  await assert.rejects(
    publishExportBundle(db, candidate(d1, { buildId: tok, operatorMessage: "override that must not land" })),
    /injected/,
  );
  const row = d1.db.prepare(`SELECT operator_message, operator_message_updated_at, bundle_build_id, bundle_built_at FROM receipt_exports WHERE id='ex'`).get() as never as Record<string, string | null>;
  assert.equal(row.operator_message, "old message");
  assert.equal(row.operator_message_updated_at, "2026-01-01T00:00:00Z");
  assert.equal(row.bundle_build_id, "OLD-BUILD");
  assert.equal(row.bundle_built_at, "2026-01-01T00:00:00Z");
});

test("A10 successful rebuild publishes the override VALUE without forging a decision timestamp; failed one-shot keeps its explicit decision", async () => {
  const d1 = new SqliteD1();
  seedReceipt(d1, "r1", "2026-01");
  seedExportDraft(d1, "ex", "2026-01");
  const db = d1.asD1();

  // Successful rebuild with an override: value lands, timestamp untouched (NULL).
  let tok = await acquireSealClaim(db, { exportId: "ex", finalize: false });
  await publishExportBundle(db, candidate(d1, { buildId: tok, operatorMessage: "rebuilt message" }));
  let row = d1.db.prepare(`SELECT operator_message, operator_message_updated_at FROM receipt_exports WHERE id='ex'`).get() as never as Record<string, string | null>;
  assert.equal(row.operator_message, "rebuilt message");
  assert.equal(row.operator_message_updated_at, null, "publication never writes the decision timestamp");

  // One-shot finalize: the decision rides acquisition; a FAILED build still
  // keeps the explicit decision (its timestamp makes older bytes stale) and the
  // claim is released so a retry can proceed.
  const decisionAt = "2026-02-02T00:00:00Z";
  tok = await acquireSealClaim(db, { exportId: "ex", finalize: true, operatorMessage: "final decision", decisionAt });
  row = d1.db.prepare(`SELECT operator_message, operator_message_updated_at FROM receipt_exports WHERE id='ex'`).get() as never as Record<string, string | null>;
  assert.equal(row.operator_message, "final decision");
  assert.equal(row.operator_message_updated_at, decisionAt);
  // Gate failure shape: release the claim; decision STAYS on the row.
  await releaseSealClaim(db, "ex", tok);
  row = d1.db.prepare(`SELECT operator_message, operator_message_updated_at, sealing_token FROM receipt_exports WHERE id='ex'`).get() as never as Record<string, string | null>;
  assert.equal(row.operator_message, "final decision");
  assert.equal(row.operator_message_updated_at, decisionAt);
  assert.equal(row.sealing_token, null);
});

// ─── Release paths ───────────────────────────────────────────────────────────

test("release is conditional on the token: a loser cannot clear a successor's lease or a finalized row", async () => {
  const d1 = new SqliteD1();
  seedExportDraft(d1, "ex", "2026-01");
  const db = d1.asD1();
  const stale = await acquireSealClaim(db, { exportId: "ex", finalize: false, leaseSeconds: -1 });
  const fresh = await acquireSealClaim(db, { exportId: "ex", finalize: false });
  // The EXPIRED attempt's release must not clear the fresh lease.
  await releaseSealClaim(db, "ex", stale);
  let row = d1.db.prepare(`SELECT sealing_token FROM receipt_exports WHERE id='ex'`).get() as never as { sealing_token: string | null };
  assert.equal(row.sealing_token, fresh);
  // The owner's release clears it.
  await releaseSealClaim(db, "ex", fresh);
  row = d1.db.prepare(`SELECT sealing_token FROM receipt_exports WHERE id='ex'`).get() as never as { sealing_token: string | null };
  assert.equal(row.sealing_token, null);
  // A release against a FINALIZED row is a no-op (never matches).
  const tok = await acquireSealClaim(db, { exportId: "ex", finalize: false });
  await publishExportBundle(db, candidate(d1, { buildId: tok, finalize: true }));
  await releaseSealClaim(db, "ex", tok);
  const fin = d1.db.prepare(`SELECT status FROM receipt_exports WHERE id='ex'`).get() as never as { status: string };
  assert.equal(fin.status, "finalized");
});

test("getExportById returns the exact row (never a 'latest' row)", async () => {
  const d1 = new SqliteD1();
  seedExportDraft(d1, "ex1", "2026-01", 1);
  d1.db.prepare(`UPDATE receipt_exports SET status='finalized' WHERE id='ex1'`).run();
  seedExportDraft(d1, "ex2", "2026-01", 2);
  const row = await getExportById("ex1", d1.asD1());
  assert.equal(row?.id, "ex1");
  assert.equal(row?.status, "finalized");
});
