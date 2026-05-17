import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveStatementWindow,
  isReceiptInWindow,
} from "@/lib/receipts/statement-window";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

function makeLine(overrides: Partial<AmexStatementLine> = {}): AmexStatementLine {
  return {
    id: "line-1",
    statement_month: "2026-03",
    transaction_date: "2026-02-01",
    posting_date: null,
    merchant: "TEST",
    amount_minor: 1000,
    currency: "JPY",
    amex_reference: null,
    matched_receipt_id: null,
    match_status: "unmatched",
    raw_json: "{}",
    created_at: "2026-02-01T00:00:00Z",
    statement_artifact_id: null,
    cardholder_name: null,
    cardholder_flag: null,
    payment_type: null,
    prepayment_flag: null,
    memo: null,
    raw_csv_line_number: null,
    source_file_sha256: null,
    imported_at: null,
    expense_category: "unknown",
    category_status: "uncategorized",
    receipt_status: "missing_receipt",
    receipt_missing_reason: null,
    business_trip_id: null,
    business_trip_status: "not_applicable",
    expense_category_code: null,
    re_review_needed: 0,
    updated_at: null,
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: "r-1",
    captured_at: "2026-01-01T00:00:00Z",
    captured_by: "test@example.com",
    source: "mobile_capture",
    original_filename: "receipt.jpg",
    payment_path: "AMEX",
    expense_type: "misc",
    transaction_date: "2026-02-01",
    merchant: "TEST",
    amount_minor: 1000,
    currency: "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "needs_review",
    original_r2_key: "receipts/r-1/file.jpg",
    original_sha256: "abc",
    original_content_type: "image/jpeg",
    original_size_bytes: 1000,
    processed_r2_key: null,
    extraction_json: null,
    legacy: 0,
    exported_month: null,
    expense_category_code: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ─── deriveStatementWindow ─────────────────────────────────────────────────

test("fallback window when no lines have dates", () => {
  const w = deriveStatementWindow([], "2026-03");
  assert.equal(w.start, "2025-12-20");
  assert.equal(w.end, "2026-02-10");
  assert.equal(w.source, "fallback");
});

test("fallback window crosses year boundary for January statement", () => {
  const w = deriveStatementWindow([], "2026-01");
  assert.equal(w.start, "2025-10-20");
  assert.equal(w.end, "2025-12-10");
  assert.equal(w.source, "fallback");
});

test("data-driven window from line dates with default slack=5", () => {
  const lines = [
    makeLine({ transaction_date: "2026-01-28" }),
    makeLine({ transaction_date: "2026-02-05" }),
    makeLine({ transaction_date: "2026-01-30" }),
  ];
  const w = deriveStatementWindow(lines, "2026-03");
  assert.equal(w.start, "2026-01-23"); // 2026-01-28 - 5
  assert.equal(w.end, "2026-02-10");    // 2026-02-05 + 5
  assert.equal(w.source, "lines");
});

test("data-driven window with mixed null dates ignores nulls", () => {
  const lines = [
    makeLine({ transaction_date: "2026-02-01" }),
    makeLine({ transaction_date: "" as unknown as string }),
    makeLine({ transaction_date: "2026-02-10" }),
  ];
  const w = deriveStatementWindow(lines, "2026-03", 3);
  assert.equal(w.start, "2026-01-29"); // 2026-02-01 - 3
  assert.equal(w.end, "2026-02-13");    // 2026-02-10 + 3
  assert.equal(w.source, "lines");
});

// ─── isReceiptInWindow ────────────────────────────────────────────────────

test("isReceiptInWindow: dateless receipt always in window", () => {
  const w = { start: "2026-01-25", end: "2026-02-10" };
  assert.ok(isReceiptInWindow(makeReceipt({ transaction_date: null }), w));
});

test("isReceiptInWindow: date within window returns true", () => {
  const w = { start: "2026-01-25", end: "2026-02-10" };
  assert.ok(isReceiptInWindow(makeReceipt({ transaction_date: "2026-02-01" }), w));
});

test("isReceiptInWindow: date before window returns false", () => {
  const w = { start: "2026-01-25", end: "2026-02-10" };
  assert.ok(!isReceiptInWindow(makeReceipt({ transaction_date: "2026-01-20" }), w));
});

test("isReceiptInWindow: date after window returns false", () => {
  const w = { start: "2026-01-25", end: "2026-02-10" };
  assert.ok(!isReceiptInWindow(makeReceipt({ transaction_date: "2026-02-15" }), w));
});

test("isReceiptInWindow: exact boundary dates are inclusive", () => {
  const w = { start: "2026-01-25", end: "2026-02-10" };
  assert.ok(isReceiptInWindow(makeReceipt({ transaction_date: "2026-01-25" }), w));
  assert.ok(isReceiptInWindow(makeReceipt({ transaction_date: "2026-02-10" }), w));
});
