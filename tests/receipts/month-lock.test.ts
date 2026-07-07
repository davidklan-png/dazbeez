import test from "node:test";
import assert from "node:assert/strict";
import { isMonthLockedForEdits, type MonthLockD1 } from "@/lib/receipts/month-lock";

// ─── Fake D1 ──────────────────────────────────────────────────────────────────
//
// isMonthLockedForEdits runs a single CASE expression that hits receipt_exports
// twice (once for 'draft', once for 'finalized'). The fake below answers that
// expression from an in-memory map keyed by `<month>:<status>`, so a test can
// express any combination — including the F1 case the production bug shipped
// with (finalized + open draft → must release the lock).
//
// Companion coverage for transactionMonthOf / ExportFinalizedError shape lives
// in tests/receipts/export.test.ts. This file owns the lock predicate only.

type ExportRow = { export_month: string; status: "draft" | "finalized" };

function createFakeDb(rows: ExportRow[] = []): MonthLockD1 {
  const byKey = new Map<string, ExportRow>();
  for (const r of rows) byKey.set(`${r.export_month}:${r.status}`, r);

  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T = unknown>(): Promise<T | null> {
              if (/status = 'draft'/i.test(sql) && /status = 'finalized'/i.test(sql)) {
                const month = String(args[0]);
                const hasDraft = byKey.has(`${month}:draft`);
                const hasFinalized = byKey.has(`${month}:finalized`);
                const locked = !hasDraft && hasFinalized ? 1 : 0;
                return { locked } as T;
              }
              return null as T | null;
            },
          };
        },
      };
    },
  };
}

// ─── F3a: finalized export and no draft → locked (the original guard) ────────

test("isMonthLockedForEdits: finalized export with no draft → locked", async () => {
  const db = createFakeDb([{ export_month: "2026-03", status: "finalized" }]);
  const locked = await isMonthLockedForEdits(db, "2026-03");
  assert.equal(locked, true, "finalized + no draft must lock edits");
});

// ─── F3b: finalized export + open draft revision → edit allowed (F1 fix) ─────
//
// This is the exact scenario createExportRevision produces: a permanent
// finalized row plus a fresh draft row. Without the draft carve-out the
// correction flow could never actually correct anything — every edit attempt
// would re-hit the finalized row and re-throw.

test("isMonthLockedForEdits: finalized export + open draft revision → released (F1 fix)", async () => {
  const db = createFakeDb([
    { export_month: "2026-03", status: "finalized" },
    { export_month: "2026-03", status: "draft" },
  ]);
  const locked = await isMonthLockedForEdits(db, "2026-03");
  assert.equal(locked, false, "draft revision must release the lock so corrections can land");
});

// ─── F3c: revision finalized (draft gone) → locked again ────────────────────
//
// Finalizing the revision closes the lock: the draft row is consumed (it
// becomes the new finalized row), only finalized remains, and the month is
// sealed once more. This re-uses the F3a fixture on purpose — the post-
// revision state is indistinguishable from the pre-correction state at the
// receipt_exports table level, which is exactly the design intent.

test("isMonthLockedForEdits: revision finalized (draft gone) → locked again", async () => {
  const db = createFakeDb([{ export_month: "2026-03", status: "finalized" }]);
  const locked = await isMonthLockedForEdits(db, "2026-03");
  assert.equal(locked, true, "after the draft closes the month must re-lock");
});

// ─── Edge cases that protect the F1 fix from regressions ─────────────────────

test("isMonthLockedForEdits: month with neither draft nor finalized → open for edits", async () => {
  const db = createFakeDb([]);
  const locked = await isMonthLockedForEdits(db, "2026-03");
  assert.equal(locked, false, "an untouched month is editable");
});

test("isMonthLockedForEdits: only a draft exists → editable (initial build, not yet shipped)", async () => {
  const db = createFakeDb([{ export_month: "2026-03", status: "draft" }]);
  const locked = await isMonthLockedForEdits(db, "2026-03");
  assert.equal(locked, false, "first-time draft must not lock the month");
});

test("isMonthLockedForEdits: draft carve-out is month-scoped (other months unaffected)", async () => {
  // A draft for March does not release the lock on April — the carve-out is
  // per-month, matching the idx_exports_one_draft partial unique index.
  const db = createFakeDb([
    { export_month: "2026-04", status: "finalized" },
    { export_month: "2026-03", status: "draft" },
  ]);
  const aprilLocked = await isMonthLockedForEdits(db, "2026-04");
  assert.equal(aprilLocked, true, "April stays locked; March's draft is irrelevant to April");
});

// ─── isMonthExportFinalized boundary (documented, not unit-tested) ────────────
//
// isMonthExportFinalized(month) intentionally does NOT take a `db` parameter —
// it calls getReceiptsDb() internally and answers only "did this month ever
// ship?". The draft-aware behavior (F1 fix) is the job of isMonthLockedForEdits
// above. Coverage for isMonthExportFinalized is provided by integration tests
// against live D1 on the Mac worker; duplicating it here would require module
// mocking we don't otherwise need.
