import test from "node:test";
import assert from "node:assert/strict";
import {
  computeReceiptLocks,
  loadReconciliationLockedReceiptIds,
  type ReceiptLockD1,
} from "@/lib/receipts/receipt-locks";
import type { PaymentPath, ReceiptRecord } from "@/lib/receipts/types";
import { D1_ID_CHUNK_SIZE } from "@/lib/receipts/db-utils";

// computeReceiptLocks is pure: feed the two query results (sealed export months
// + the receipt→statement-month map for finalized reconciliations) and assert
// the lock matrix. The I/O wrappers (loadSealedExportMonths, the recon query)
// are integration-tested against live D1 on the Mac worker.

function receipt(partial: Partial<ReceiptRecord>): ReceiptRecord {
  return {
    id: "r1",
    payment_path: "CASH",
    transaction_date: "2026-03-10",
    ...partial,
  } as ReceiptRecord;
}

// ─── EXPORT lock (non-AMEX receipt whose transaction month is sealed) ────────

test("computeReceiptLocks: CASH receipt in a sealed export month → export-locked", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "cash", payment_path: "CASH", transaction_date: "2026-03-10" })],
    new Set(["2026-03"]),
    new Map(),
  );
  const info = locks.get("cash");
  assert.equal(info?.locked, true);
  assert.equal(info?.kind, "export");
  assert.equal(info?.month, "2026-03");
});

test("computeReceiptLocks: DIGITAL receipt in a sealed export month → export-locked", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "dig", payment_path: "DIGITAL", transaction_date: "2026-03-10" })],
    new Set(["2026-03"]),
    new Map(),
  );
  assert.equal(locks.get("dig")?.locked, true);
  assert.equal(locks.get("dig")?.kind, "export");
});

test("computeReceiptLocks: a draft revision releases the export lock (month not in sealed set)", () => {
  // loadSealedExportMonths excludes months that have an open draft revision, so
  // the month simply isn't in the sealed set passed in.
  const locks = computeReceiptLocks(
    [receipt({ id: "cash", payment_path: "CASH", transaction_date: "2026-03-10" })],
    new Set(), // 2026-03 has a draft → not sealed
    new Map(),
  );
  assert.equal(locks.get("cash")?.locked, false);
});

test("computeReceiptLocks: export lock is month-scoped (other sealed months don't lock)", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "cash", payment_path: "CASH", transaction_date: "2026-03-10" })],
    new Set(["2026-04"]),
    new Map(),
  );
  assert.equal(locks.get("cash")?.locked, false);
});

test("computeReceiptLocks: undated CASH receipt is never export-locked", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "undated", payment_path: "CASH", transaction_date: null })],
    new Set(["2026-07"]),
    new Map(),
  );
  assert.equal(locks.get("undated")?.locked, false);
});

// ─── RECONCILIATION lock (AMEX/UNKNOWN matched to a finalized statement line) ─

test("computeReceiptLocks: AMEX receipt matched to a finalized reconciliation → recon-locked", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "amex", payment_path: "AMEX", transaction_date: "2026-06-15" })],
    new Set(),
    new Map([["amex", "2026-06"]]),
  );
  const info = locks.get("amex");
  assert.equal(info?.locked, true);
  assert.equal(info?.kind, "reconciliation");
  assert.equal(info?.month, "2026-06");
});

test("computeReceiptLocks: AMEX receipt with no matched line → unlocked (even in a sealed export month)", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "amex", payment_path: "AMEX", transaction_date: "2026-06-15" })],
    new Set(["2026-06"]), // would export-lock a CASH receipt, but AMEX is not export-gated
    new Map(),
  );
  assert.equal(locks.get("amex")?.locked, false);
});

// ─── Path-gating: each lock owns its own population (audit A5) ───────────────

test("computeReceiptLocks: CASH receipt is NOT reconciliation-gated even if matched to a finalized line", () => {
  // Path-agnostic server predicate aside, the UI lock model assigns the recon
  // gate to AMEX/UNKNOWN only — CASH/DIGITAL have no statement line to match.
  const locks = computeReceiptLocks(
    [receipt({ id: "cash", payment_path: "CASH", transaction_date: "2026-03-10" })],
    new Set(),
    new Map([["cash", "2026-06"]]),
  );
  assert.equal(locks.get("cash")?.locked, false);
});

test("computeReceiptLocks: AMEX receipt is NOT export-gated even when its month is sealed (vice versa)", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "amex", payment_path: "AMEX", transaction_date: "2026-06-15" })],
    new Set(["2026-06"]),
    new Map(),
  );
  assert.equal(locks.get("amex")?.locked, false);
});

// ─── UNKNOWN: export-gated by month, recon-gated when matched (the safe path) ─

test("computeReceiptLocks: UNKNOWN receipt in a sealed export month → export-locked", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "unk", payment_path: "UNKNOWN", transaction_date: "2026-06-15" })],
    new Set(["2026-06"]),
    new Map(),
  );
  assert.equal(locks.get("unk")?.locked, true);
  assert.equal(locks.get("unk")?.kind, "export");
});

test("computeReceiptLocks: UNKNOWN receipt matched to a finalized reconciliation → recon-locked (server predicate is path-agnostic)", () => {
  const locks = computeReceiptLocks(
    [receipt({ id: "unk", payment_path: "UNKNOWN", transaction_date: "2026-06-15" })],
    new Set(),
    new Map([["unk", "2026-06"]]),
  );
  assert.equal(locks.get("unk")?.locked, true);
  assert.equal(locks.get("unk")?.kind, "reconciliation");
});

// ─── Mixed set + coverage invariant ─────────────────────────────────────────

test("computeReceiptLocks: every input receipt gets a Map entry (single .get lookup, no default needed)", () => {
  const receipts = [
    receipt({ id: "a", payment_path: "CASH", transaction_date: "2026-03-10" }),
    receipt({ id: "b", payment_path: "AMEX", transaction_date: "2026-06-15" }),
  ];
  const locks = computeReceiptLocks(receipts, new Set(["2026-03"]), new Map([["b", "2026-06"]]));
  assert.equal(locks.size, 2);
  assert.equal(locks.get("a")?.kind, "export");
  assert.equal(locks.get("b")?.kind, "reconciliation");
});

test("computeReceiptLocks: empty input → empty map", () => {
  const locks = computeReceiptLocks([], new Set(["2026-03"]), new Map());
  assert.equal(locks.size, 0);
});

// ─── loadReconciliationLockedReceiptIds (fake D1) ────────────────────────────

function fakeReconDb(rows: Array<{ rid: string; m: string }>): ReceiptLockD1 {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T = unknown>(): Promise<{ results?: T[] }> {
              return { results: rows as unknown as T[] };
            },
          };
        },
      };
    },
  };
}

test("loadReconciliationLockedReceiptIds: builds id→statement-month map", async () => {
  const db = fakeReconDb([
    { rid: "a", m: "2026-06" },
    { rid: "b", m: "2026-05" },
  ]);
  const out = await loadReconciliationLockedReceiptIds(db, ["a", "b"]);
  assert.equal(out.get("a"), "2026-06");
  assert.equal(out.get("b"), "2026-05");
  assert.equal(out.size, 2);
});

test("loadReconciliationLockedReceiptIds: first writer wins when a receipt matches several lines in the same finalized month", async () => {
  const db = fakeReconDb([
    { rid: "a", m: "2026-06" },
    { rid: "a", m: "2026-06" },
  ]);
  const out = await loadReconciliationLockedReceiptIds(db, ["a"]);
  assert.equal(out.size, 1);
  assert.equal(out.get("a"), "2026-06");
});

test("loadReconciliationLockedReceiptIds: empty id list → empty map, no query", async () => {
  let prepared = false;
  const db: ReceiptLockD1 = {
    prepare() {
      prepared = true;
      return { bind: () => ({ all: async () => ({ results: [] }) }) };
    },
  };
  const out = await loadReconciliationLockedReceiptIds(db, []);
  assert.equal(out.size, 0);
  assert.equal(prepared, false, "must short-circuit and not run a query for empty input");
});

// ─── ADR 0012: drafted months are excluded from the recon-locked set ─────────

test("loadReconciliationLockedReceiptIds: query excludes months that have an open export draft", async () => {
  // A drafted month must NOT appear in the locked set — otherwise the queue
  // over-reports a 409 the server would no longer throw. The canned-fake style
  // can't execute the NOT EXISTS, so assert the exclusion clause is in the
  // emitted SQL (live behavior is covered by the server carve-out tests).
  let capturedSql = "";
  const recording: ReceiptLockD1 = {
    prepare(sql: string) {
      capturedSql = sql;
      return {
        bind(..._args: unknown[]) {
          return {
            async all<T = unknown>(): Promise<{ results?: T[] }> {
              return { results: [] };
            },
          };
        },
      };
    },
  };
  await loadReconciliationLockedReceiptIds(recording, ["a"]);
  assert.match(capturedSql, /NOT EXISTS/i);
  assert.match(capturedSql, /receipt_exports/i);
  assert.match(capturedSql, /status = 'draft'/i);
});

test("computeReceiptLocks: AMEX receipt whose finalized-recon month has a draft → UNLOCKED (carve-out)", () => {
  // End-to-end effect: a drafted month is excluded from the recon-locked map by
  // loadReconciliationLockedReceiptIds, so the receipt the operator wants to
  // correct surfaces unlocked (empty map here models the exclusion).
  const locks = computeReceiptLocks(
    [receipt({ id: "amex", payment_path: "AMEX", transaction_date: "2026-06-15" })],
    new Set(),
    new Map(),
  );
  assert.equal(locks.get("amex")?.locked, false);
});

// Static guard: keep the PaymentPath literals honest against the lock model.
test("computeReceiptLocks: covers all four payment paths", () => {
  const paths: PaymentPath[] = ["AMEX", "CASH", "DIGITAL", "UNKNOWN"];
  const receipts = paths.map((p, i) =>
    receipt({ id: p, payment_path: p, transaction_date: "2026-06-15" }),
  );
  // Sealed export month + a finalized reconciliation matching every id: each
  // path should take the lock its model assigns (export for CASH/DIGITAL/UNKNOWN,
  // reconciliation for AMEX).
  const locks = computeReceiptLocks(
    receipts,
    new Set(["2026-06"]),
    new Map(paths.map((p) => [p, "2026-06"])),
  );
  assert.equal(locks.get("AMEX")?.kind, "reconciliation");
  assert.equal(locks.get("CASH")?.kind, "export");
  assert.equal(locks.get("DIGITAL")?.kind, "export");
  assert.equal(locks.get("UNKNOWN")?.kind, "reconciliation"); // recon wins (checked first)
});

// ─── D1 bind-limit chunking (regression: all-months review crash) ───────────

test("loadReconciliationLockedReceiptIds: chunks receipt ids to stay under D1's bind limit", async () => {
  // The review queue passes 100+ ids for an all-months view; a single IN(?,…)
  // exceeded D1's bound-param limit and crashed /receipts/review. The query must
  // chunk over D1_ID_CHUNK_SIZE. Recording fake counts bind args per prepare.
  const bindCounts: number[] = [];
  const recording: ReceiptLockD1 = {
    prepare() {
      return {
        bind(...args: unknown[]) {
          bindCounts.push(args.length);
          return {
            async all<T = unknown>(): Promise<{ results?: T[] }> {
              return { results: [] };
            },
          };
        },
      };
    },
  };
  const ids = Array.from({ length: D1_ID_CHUNK_SIZE + 5 }, (_, i) => `r${i}`);
  await loadReconciliationLockedReceiptIds(recording, ids);
  assert.ok(bindCounts.length >= 2, `expected ≥2 chunked queries, got ${bindCounts.length}`);
  assert.ok(
    Math.max(...bindCounts) <= D1_ID_CHUNK_SIZE,
    `largest chunk ${Math.max(...bindCounts)} exceeds D1_ID_CHUNK_SIZE (${D1_ID_CHUNK_SIZE})`,
  );
});
