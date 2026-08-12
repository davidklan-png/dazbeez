import test from "node:test";
import assert from "node:assert/strict";
import {
  listAllReceiptsInMonth,
  listAmexReceiptsForReconcile,
} from "@/lib/receipts/db";
import type { ReceiptRecord } from "@/lib/receipts/types";

// T1-7 (audited 2026-08-12, docs/audits/2026-08-backlog-questions.md §5): the two
// exhaustive reads that feed the SEALED export bundle (listAllReceiptsInMonth) and
// the reconcile view (listAmexReceiptsForReconcile) page internally and THROW at a
// hard cap rather than silently truncate — because a receipt omitted from the
// sealed bundle is a receipt the accountant never sees (worst-class failure on a
// 10-year tax record). The throw was the safety, and nothing asserted it: deleting
// the guard would have failed no test. These tests pin the throw itself.
//
// Both functions take an optional `db` (on `opts`) purely as a testability seam —
// same convention as softDeleteReceipt / unfinalizeReconciliation (production
// callers omit it; the default resolves the live D1 binding). The fake dispatches
// on SQL: the BETWEEN window query is the dated reconcile read, the
// `transaction_date IS NULL` query is the undated reconcile read, and anything
// else is the generic listReceiptRecords read that listAllReceiptsInMonth pages
// through. Rows are opaque stubs — the throw path only counts them, it does not
// read fields.

let seq = 0;
function mkReceipt(): ReceiptRecord {
  seq += 1;
  return { id: `r${seq}` } as unknown as ReceiptRecord;
}

/** A full 500-row page is the smallest input that reaches a throw, because the
 *  paging loops short-circuit (`page.length < PAGE`) on any shorter page. */
function fullPage(n = 500): ReceiptRecord[] {
  return Array.from({ length: n }, () => mkReceipt());
}

interface FakeCfg {
  /** Successive pages for the generic listReceiptRecords read. */
  receiptPages?: ReceiptRecord[][];
  /** Successive pages for the dated BETWEEN reconcile read. */
  datedPages?: ReceiptRecord[][];
  /** Rows for the undated `transaction_date IS NULL` reconcile read. */
  undatedRows?: ReceiptRecord[];
}

function fakeDb(cfg: FakeCfg) {
  let receiptI = 0;
  let datedI = 0;

  function dispatch(sql: string): ReceiptRecord[] {
    if (/BETWEEN \? AND \?/i.test(sql)) {
      const pages = cfg.datedPages ?? [];
      return datedI < pages.length ? pages[datedI++] : [];
    }
    if (/transaction_date IS NULL/i.test(sql)) {
      return cfg.undatedRows ?? [];
    }
    const pages = cfg.receiptPages ?? [];
    return receiptI < pages.length ? pages[receiptI++] : [];
  }

  // `prepare` returns a bound statement; `.bind()` returns the same object so both
  // `.prepare(sql).all()` (undated query) and `.prepare(sql).bind(...).all()` work.
  function prepare(sql: string) {
    const bound = {
      bind(..._args: unknown[]) {
        return this;
      },
      async all<T>(): Promise<{
        results: T[];
        success: true;
        meta: { changes: number };
      }> {
        return {
          results: dispatch(sql) as T[],
          success: true,
          meta: { changes: 0 },
        };
      },
      async first<T>(): Promise<T | null> {
        return null;
      },
      async run() {
        return { success: true, meta: { changes: 0 } };
      },
    };
    return bound;
  }

  return { db: { prepare } as unknown as D1Database };
}

// ─── listAllReceiptsInMonth ──────────────────────────────────────────────────

test("listAllReceiptsInMonth: throws at hardCap instead of silently truncating", async () => {
  // hardCap=3 but the first full 500-row page already blows past it — the throw
  // fires before the trailing short page is ever read.
  const { db } = fakeDb({ receiptPages: [fullPage(), fullPage(), []] });
  await assert.rejects(
    listAllReceiptsInMonth("2026-07", { hardCap: 3, db }),
    /listAllReceiptsInMonth\(2026-07\) hit hard cap of 3 rows/,
  );
});

test("listAllReceiptsInMonth: returns every row when the month is under the cap", async () => {
  // A short first page (2 < 500) returns immediately — proves the throw above is
  // cap-specific, not triggered by any full page.
  const { db } = fakeDb({ receiptPages: [[mkReceipt(), mkReceipt()]] });
  const out = await listAllReceiptsInMonth("2026-07", { db });
  assert.equal(out.length, 2);
});

// ─── listAmexReceiptsForReconcile ────────────────────────────────────────────

test("listAmexReceiptsForReconcile: throws at the dated-row cap mid-window", async () => {
  const { db } = fakeDb({ datedPages: [fullPage(), fullPage(), []] });
  await assert.rejects(
    listAmexReceiptsForReconcile(
      { start: "2026-07-01", end: "2026-07-31" },
      { hardCap: 3, db },
    ),
    /hard cap of 3 dated rows/,
  );
});

test("listAmexReceiptsForReconcile: throws after union with undated rows crosses the cap", async () => {
  // Dated window returns a SHORT page (4 < 500) so the dated loop exits WITHOUT
  // throwing; the separate undated query then pushes the total (4 + 3 = 7) past
  // hardCap=5, firing the post-union guard — a distinct throw site from the
  // mid-window one above.
  const { db } = fakeDb({
    datedPages: [[mkReceipt(), mkReceipt(), mkReceipt(), mkReceipt()]],
    undatedRows: [mkReceipt(), mkReceipt(), mkReceipt()],
  });
  await assert.rejects(
    listAmexReceiptsForReconcile(
      { start: "2026-07-01", end: "2026-07-31" },
      { hardCap: 5, db },
    ),
    /after union with undated rows/,
  );
});

test("listAmexReceiptsForReconcile: returns dated + undated rows when under the cap", async () => {
  const { db } = fakeDb({
    datedPages: [[mkReceipt(), mkReceipt()]],
    undatedRows: [mkReceipt()],
  });
  const out = await listAmexReceiptsForReconcile(
    { start: "2026-07-01", end: "2026-07-31" },
    { db },
  );
  assert.equal(out.length, 3);
});
