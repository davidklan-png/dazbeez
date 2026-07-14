import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCategoryCellProps,
  buildCategoryPatchBody,
} from "@/lib/receipts/category-cell";
import type { ExportRow } from "@/lib/receipts/types";

// Minimal ExportRow builder — only the fields buildCategoryCellProps reads
// (rowType / receiptId / lineId / category* / attendees) vary per test; the
// rest are inert defaults so the shape stays valid against the interface.
function makeRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    rowType: "amex_line",
    lineId: "line-default",
    matchStatus: "matched",
    receiptStatus: "matched",
    missingReceiptReason: null,
    cardholderName: null,
    businessTripStatus: "not_applicable",
    receiptId: "rec-default",
    status: "reviewed",
    originalR2Key: null,
    transactionDate: "2026-06-11",
    merchant: "Test Merchant",
    amountMinor: 1000,
    currency: "JPY",
    expenseType: "UNKNOWN",
    expenseCategoryCode: "communications",
    expenseCategoryJa: "通信費",
    expenseCategoryEn: "Communications expenses",
    paymentPath: "AMEX",
    businessPurpose: null,
    attendees: [],
    invoiceRegistrationNumber: null,
    qualifiedInvoiceStatus: "not_checked",
    taxRate: null,
    taxAmountMinor: null,
    sourceType: null,
    counterpartyName: null,
    ...overrides,
  };
}

const matchedLine = () =>
  makeRow({ rowType: "amex_line", receiptId: "rec-1", lineId: "line-1" });
const noReceiptLine = () =>
  makeRow({
    rowType: "amex_line",
    receiptId: null,
    lineId: "line-2",
    receiptStatus: "missing_receipt",
    matchStatus: "no_receipt",
  });
const cashReceipt = () =>
  makeRow({
    rowType: "receipt",
    receiptId: "rec-2",
    lineId: null,
    paymentPath: "CASH",
  });

// ─── write-path routing (source of truth) ──────────────────────────────────

test("category-cell routing: matched AMEX line → receipt PATCH (receipt shadows line)", () => {
  // A matched line's category lives on the RECEIPT. Writing it on the line would
  // desync the manifest (resolveLineCategory prefers the receipt).
  const p = buildCategoryCellProps(matchedLine(), false, false);
  assert.deepEqual(p.route, { kind: "receipt", id: "rec-1" });
  assert.equal(p.sourceLabel, "from receipt");
  assert.equal(p.editable, true);
});

test("category-cell routing: no-receipt / unmatched AMEX line → line PATCH", () => {
  const p = buildCategoryCellProps(noReceiptLine(), false, false);
  assert.deepEqual(p.route, { kind: "line", id: "line-2" });
  assert.equal(p.sourceLabel, "on line");
  assert.equal(p.editable, true);
});

test("category-cell routing: cash/digital receipt row → receipt PATCH", () => {
  const p = buildCategoryCellProps(cashReceipt(), false, false);
  assert.deepEqual(p.route, { kind: "receipt", id: "rec-2" });
  assert.equal(p.sourceLabel, "from receipt");
  assert.equal(p.editable, true);
});

// ─── lock-state rendering ──────────────────────────────────────────────────

test("category-cell locks: open month → everything editable", () => {
  for (const row of [matchedLine(), noReceiptLine(), cashReceipt()]) {
    const p = buildCategoryCellProps(row, false, false);
    assert.equal(p.editable, true);
    assert.equal(p.disabledReason, null);
  }
});

test("category-cell locks: export finalized → all editing disabled", () => {
  for (const row of [matchedLine(), noReceiptLine(), cashReceipt()]) {
    const p = buildCategoryCellProps(row, true, false);
    assert.equal(p.editable, false, `expected disabled for ${row.rowType}`);
    assert.ok(
      p.disabledReason && /sealed/i.test(p.disabledReason),
      `expected sealed reason for ${row.rowType}`,
    );
  }
});

test("category-cell locks: reconciliation sealed + export draft → AMEX lines disabled, cash/digital editable", () => {
  // The honest asymmetry: the line PATCH 409s and a matched receipt PATCH 409s
  // once the month's reconciliation is finalized, but a standalone cash/digital
  // receipt is matched to no AMEX line so its PATCH stays open (June's state).
  const ml = buildCategoryCellProps(matchedLine(), false, true);
  assert.equal(ml.editable, false);
  assert.match(ml.disabledReason!, /reconciliation is sealed/i);

  const nr = buildCategoryCellProps(noReceiptLine(), false, true);
  assert.equal(nr.editable, false);
  assert.match(nr.disabledReason!, /reconciliation is sealed/i);

  const cash = buildCategoryCellProps(cashReceipt(), false, true);
  assert.equal(cash.editable, true, "cash/digital receipt stays editable when only reconciliation is sealed");
  assert.equal(cash.disabledReason, null);
});

test("category-cell: resolved category + gloss + attendees pass through", () => {
  const p = buildCategoryCellProps(
    makeRow({
      expenseCategoryCode: "entertainment",
      expenseCategoryJa: "交際費",
      expenseCategoryEn: "Entertainment expenses",
      attendees: ["T Sato"],
    }),
    false,
    false,
  );
  assert.equal(p.code, "entertainment");
  assert.equal(p.categoryJa, "交際費");
  assert.equal(p.categoryEn, "Entertainment expenses");
  assert.equal(p.hasAttendees, true);
});

// ─── #67 regression: sparse PATCH body (both endpoints) ────────────────────

test("category-cell PATCH body: single field — no sibling fields touched (#67)", () => {
  // Both endpoints are sparse: only keys present are written. Sending just
  // expenseCategoryCode guarantees merchant/amount/attendees/tax/etc. are never
  // clobbered from this surface.
  const body = buildCategoryPatchBody("travel_transportation");
  assert.deepEqual(body, { expenseCategoryCode: "travel_transportation" });
  assert.deepEqual(Object.keys(body).sort(), ["expenseCategoryCode"]);

  const cleared = buildCategoryPatchBody("");
  assert.deepEqual(cleared, { expenseCategoryCode: null });
  assert.deepEqual(Object.keys(cleared).sort(), ["expenseCategoryCode"]);
});
