import test from "node:test";
import assert from "node:assert/strict";
import { updateAmexReconciliation } from "@/lib/receipts/db";

// T1-10 (rank 4, docs/audits/2026-08-backlog-questions.md §6): the cross-month
// sealed-claim guard INSIDE updateAmexReconciliation. A receipt already confirmed
// against a line in a DIFFERENT finalized statement month must not be linkable
// into an open month — doing so would mutate that sealed month's receipt
// (merchant/date/status), breaking finalized-month immutability. rejectIfFinalized
// only checks the TARGET line's month; this in-function SELECT is the defense that
// catches a receipt claimed by a different finalized month. Previously untested.
//
// WHAT THIS PINS: that confirming a receipt with an existing cross-month finalized
// claim throws before updateAmexReconciliation mutates anything.
//
// WHY BEHAVIOURAL (opts.db seam), NOT STRUCTURAL: unlike T1-9, the guard is a
// SELECT (not a mutation whose changes-count a fake would have to model). The fake
// returns a sealed-claim ROW for the guard SELECT; if the guard is removed, that
// SELECT is never issued, the fake is never asked for the row, and nothing throws
// — so removal is caught cleanly (no "model the guard's logic" trap). That is the
// prompt's "take the real seam if it can catch removal" branch.
//
// *** IF THIS TEST FAILS AFTER A REFACTOR: verify the cross-month sealed-claim
// guard still holds (confirming a receipt claimed by a different finalized month
// still throws BEFORE any mutation), then update the fake if the query shape
// changed. DO NOT WEAKEN THE ASSERTION (e.g. stop expecting the throw, or stop
// returning a sealed-claim row) to make it pass — that silently reintroduces the
// finalized-month-immutability gap this test exists to close. (#175 failure mode.)

/** Fake D1 for updateAmexReconciliation up to the cross-month guard. Dispatches
 *  `.first()` on the SQL so the function reaches the guard with the right state. */
function fakeDbWithSealedClaim() {
  function prepare(sql: string) {
    const stmt = {
      _sql: sql,
      bind(..._args: unknown[]) {
        return this;
      },
      async all<T = unknown>() {
        return { results: [] as T[], success: true as const, meta: { changes: 0 } };
      },
      async first<T = unknown>(): Promise<T | null> {
        // The guard SELECT: amex_statement_lines JOIN amex_reconciliations. Return
        // a sealed claim in a DIFFERENT month → the guard must throw.
        if (/JOIN amex_reconciliations/i.test(sql)) {
          return { statement_month: "2026-06" } as T;
        }
        // rejectIfFinalized: SELECT id FROM amex_reconciliations ... → not finalized.
        if (/FROM amex_reconciliations/i.test(sql)) {
          return null;
        }
        // The "previous line" SELECT → an open-month line being confirmed.
        return {
          matched_receipt_id: null,
          match_status: "unmatched",
          receipt_status: "missing_receipt",
          merchant: "Card fee",
          transaction_date: "2026-07-01",
          statement_month: "2026-07",
        } as T;
      },
      async run() {
        return { success: true as const, meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  const db = {
    prepare,
    async batch(stmts: ReturnType<typeof prepare>[]) {
      return stmts.map(() => ({ success: true as const, meta: { changes: 1 } }));
    },
  };
  return db as unknown as D1Database;
}

test("T1-10: confirming a receipt already claimed by a DIFFERENT finalized month throws before any mutation", async () => {
  // The target line is in open 2026-07; receipt-A is already confirmed in
  // finalized 2026-06 (the guard SELECT returns that sealed claim). Linking it
  // here would mutate 2026-06's sealed receipt — the guard must refuse.
  await assert.rejects(
    updateAmexReconciliation(
      "line-2026-07",
      "receipt-A",
      "confirmed",
      "operator",
      fakeDbWithSealedClaim(),
    ),
    /cannot be linked to another month/,
  );
});
