import test from "node:test";
import assert from "node:assert/strict";
import {
  rejectIfFinalized,
  rejectIfReceiptInFinalizedReconciliation,
} from "@/lib/receipts/db";

// ADR 0012: the reconciliation lock becomes draft-aware for RECEIPT edits only.
// rejectIfReceiptInFinalizedReconciliation releases when the matched statement
// month has an open export draft (isMonthLockedForEdits → false). The LINE seal
// (rejectIfFinalized) is deliberately NOT draft-aware — a format-only export
// revision must not reopen match assignments. This file guards both halves.

function fakeDb(opts: {
  /** Finalized-reconciliation match for the receipt (the JOIN row), or null. */
  match: { id: string; statement_month: string } | null;
  /** isMonthLockedForEdits result: 0 = open draft (released), 1 = no draft (locked). */
  locked: 0 | 1;
  /** Whether a finalized amex_reconciliations row exists for the month (rejectIfFinalized). */
  finalizedRecon: boolean;
}) {
  const db = {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first<T = unknown>(): Promise<T | null> {
              // Receipt-reconciliation join (has amex_statement_lines).
              if (/FROM amex_statement_lines/i.test(sql)) {
                return (opts.match ?? null) as T | null;
              }
              // isMonthLockedForEdits (CASE over receipt_exports).
              if (/CASE/i.test(sql) && /receipt_exports/i.test(sql)) {
                return { locked: opts.locked } as T;
              }
              // rejectIfFinalized line seal (SELECT id FROM amex_reconciliations … finalized).
              if (/FROM amex_reconciliations/i.test(sql) && /finalized/i.test(sql)) {
                return (opts.finalizedRecon ? { id: "rec" } : null) as T | null;
              }
              return null as T | null;
            },
          };
        },
      };
    },
  };
  return db as unknown as D1Database;
}

// ─── Receipt-scope carve-out (draft-aware) ───────────────────────────────────

test("rejectIfReceiptInFinalizedReconciliation: no finalized match → returns (no throw)", async () => {
  await rejectIfReceiptInFinalizedReconciliation(
    fakeDb({ match: null, locked: 1, finalizedRecon: false }),
    "r1",
  );
});

test("rejectIfReceiptInFinalizedReconciliation: match + month locked (no draft) → throws", async () => {
  await assert.rejects(
    rejectIfReceiptInFinalizedReconciliation(
      fakeDb({ match: { id: "rec", statement_month: "2026-06" }, locked: 1, finalizedRecon: true }),
      "r1",
    ),
    /locked by a finalized reconciliation/i,
  );
});

test("rejectIfReceiptInFinalizedReconciliation: match + open draft (not locked) → released (ADR 0012)", async () => {
  // Same finalized reconciliation, but an open export draft releases the RECEIPT edit.
  await rejectIfReceiptInFinalizedReconciliation(
    fakeDb({ match: { id: "rec", statement_month: "2026-06" }, locked: 0, finalizedRecon: true }),
    "r1",
  );
});

// ─── Line-seal scoping (NOT draft-aware — the mitigation boundary) ───────────

test("rejectIfFinalized (line seal): finalized → throws EVEN with an open draft (strict by design)", async () => {
  // Contrast with the receipt carve-out above: the line-level seal is the
  // receipt-vs-line scoping mitigation and must not be released by a draft.
  await assert.rejects(
    rejectIfFinalized(fakeDb({ match: null, locked: 0, finalizedRecon: true }), "2026-06"),
    /finalized/i,
  );
});

test("rejectIfFinalized (line seal): not finalized → returns (no throw)", async () => {
  await rejectIfFinalized(fakeDb({ match: null, locked: 0, finalizedRecon: false }), "2026-06");
});
