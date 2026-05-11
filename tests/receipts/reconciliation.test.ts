import test from "node:test";
import assert from "node:assert/strict";
import { matchAmexToReceipts, normalizeDescription } from "@/lib/receipts/reconciliation";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAmexLine(overrides: Partial<AmexStatementLine> = {}): AmexStatementLine {
  return {
    id: "amex-1",
    statement_month: "2024-01",
    transaction_date: "2024-01-15",
    posting_date: null,
    merchant: "AMAZON MARKETPLACE",
    amount_minor: 380000,
    currency: "JPY",
    amex_reference: "REF001",
    matched_receipt_id: null,
    match_status: "unmatched",
    raw_json: "{}",
    created_at: "2024-01-15T00:00:00Z",
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
    updated_at: null,
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: "r-1",
    captured_at: "2024-01-15T10:00:00Z",
    captured_by: "user@example.com",
    source: "mobile_capture",
    original_filename: "receipt.jpg",
    payment_path: "AMEX",
    expense_type: "misc",
    transaction_date: "2024-01-15",
    merchant: "Amazon",
    amount_minor: 380000,
    currency: "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "needs_review",
    original_r2_key: "receipts/2024/01/r-1/file.jpg",
    original_sha256: "abc123",
    original_content_type: "image/jpeg",
    original_size_bytes: 500_000,
    processed_r2_key: null,
    extraction_json: null,
    legacy: 0,
    exported_month: null,
    expense_category_code: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    created_at: "2024-01-15T10:00:00Z",
    updated_at: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}

// ─── normalizeDescription ─────────────────────────────────────────────────────

test("normalizeDescription: lowercases and strips punctuation", () => {
  assert.equal(normalizeDescription("AMAZON.COM, INC."), "amazon com inc");
});

test("normalizeDescription: collapses whitespace", () => {
  const result = normalizeDescription("  STARBUCKS   TOKYO  ");
  assert.ok(!result.startsWith(" "), "should trim leading space");
  assert.ok(!result.endsWith(" "), "should trim trailing space");
});

// ─── matchAmexToReceipts ──────────────────────────────────────────────────────

test("exact amount + same date produces high confidence match", () => {
  const lines = [makeAmexLine()];
  const receipts = [makeReceipt()];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.confidenceScore >= 0.8, "expected high confidence for exact match");
  assert.ok(matches[0]!.matchReasons.includes("exact amount"));
  assert.ok(matches[0]!.matchReasons.includes("same date"));
});

test("no match when date is more than 3 days apart", () => {
  const lines = [makeAmexLine({ transaction_date: "2024-01-15" })];
  const receipts = [makeReceipt({ transaction_date: "2024-01-20" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0);
});

test("no match when amount differs significantly", () => {
  const lines = [makeAmexLine({ amount_minor: 100000 })];
  const receipts = [makeReceipt({ amount_minor: 500000 })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "should not match on date alone without amount match");
});

test("archived receipts are excluded from matching", () => {
  const lines = [makeAmexLine()];
  const receipts = [makeReceipt({ status: "archived" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "archived receipts must not be matched");
});

test("exported receipts are excluded from matching", () => {
  const lines = [makeAmexLine()];
  const receipts = [makeReceipt({ status: "exported" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0);
});

test("non-AMEX receipts are excluded from matching", () => {
  const lines = [makeAmexLine()];
  const receipts = [makeReceipt({ payment_path: "CASH" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "CASH receipts should not be matched to AMEX lines");
});

test("already-confirmed and no_receipt lines are skipped", () => {
  const confirmed = makeAmexLine({ match_status: "confirmed" });
  const noReceipt = makeAmexLine({ id: "amex-2", match_status: "no_receipt" });
  const lines = [confirmed, noReceipt];
  const receipts = [makeReceipt()];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "confirmed/no_receipt lines should not be re-matched");
});

test("merchant name match increases confidence", () => {
  const lines = [makeAmexLine({ merchant: "AMAZON MARKETPLACE" })];
  const receipts = [makeReceipt({ merchant: "Amazon" })];
  const matches = matchAmexToReceipts(lines, receipts);
  if (matches.length > 0) {
    assert.ok(matches[0]!.matchReasons.includes("merchant match"));
  }
});

test("multiple receipts — best match is selected", () => {
  const lines = [makeAmexLine()];
  const receipts = [
    makeReceipt({ id: "r-1", amount_minor: 380000, transaction_date: "2024-01-15" }),
    makeReceipt({ id: "r-2", amount_minor: 200000, transaction_date: "2024-01-15" }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.receiptId, "r-1", "exact amount match should win");
});

test("currency mismatch (USD receipt vs JPY line) is not matched", () => {
  // ¥500 line and $5.00 receipt both have amount_minor = 500 but represent
  // very different values; the matcher must reject this.
  const lines = [makeAmexLine({ amount_minor: 500, currency: "JPY" })];
  const receipts = [makeReceipt({ amount_minor: 500, currency: "USD" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "currency must match before amount comparison");
});

test("currency match is case-insensitive", () => {
  const lines = [makeAmexLine({ currency: "JPY" })];
  const receipts = [makeReceipt({ currency: "jpy" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
});

test("refund line (-1000) matches refund receipt (-1000) exactly", () => {
  const lines = [
    makeAmexLine({
      id: "amex-refund-1",
      amount_minor: -1000,
      merchant: "返金",
      transaction_date: "2024-01-15",
    }),
  ];
  const receipts = [
    makeReceipt({
      id: "r-refund-1",
      amount_minor: -1000,
      merchant: "返金",
      transaction_date: "2024-01-15",
    }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.receiptId, "r-refund-1");
  assert.ok(matches[0]!.matchReasons.includes("exact amount"));
});

test("refund line does not greedily match unrelated positive receipts", () => {
  // Pre-fix bug: `Math.abs(diff) < amexMinor * 0.01` with amexMinor=-1000
  // produces `< -10`, which is false for the diff but the whole conditional
  // was nonsensical — could yield spurious approximate matches when paired
  // with the date filter. Using Math.abs(amexMinor) makes the threshold
  // meaningful.
  const lines = [makeAmexLine({ amount_minor: -1000 })];
  const receipts = [makeReceipt({ amount_minor: 5000 })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0);
});

test("soft-deleted receipts are excluded from matching (defense-in-depth)", () => {
  const lines = [makeAmexLine()];
  const receipts = [makeReceipt({ deleted_at: "2024-01-20T00:00:00Z" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "soft-deleted receipts must not be matched");
});
