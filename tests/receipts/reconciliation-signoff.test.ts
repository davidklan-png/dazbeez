import test from "node:test";
import assert from "node:assert/strict";
import { validateAmexLinesForSignoff } from "@/lib/receipts/reconciliation-signoff";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

function makeLine(overrides: Partial<AmexStatementLine> = {}): AmexStatementLine {
  return {
    id: "line-1",
    statement_month: "2026-07",
    transaction_date: "2026-07-15",
    posting_date: null,
    merchant: "TEST MERCHANT",
    amount_minor: 1000,
    currency: "JPY",
    amex_reference: "REF001",
    matched_receipt_id: null,
    match_status: "confirmed",
    raw_json: "{}",
    created_at: "2026-07-15T00:00:00Z",
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
    receipt_status: "matched",
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
    captured_at: "2026-07-15T10:00:00Z",
    captured_by: "test",
    source: "mobile_capture",
    original_filename: "r.jpg",
    payment_path: "AMEX",
    expense_type: "misc",
    transaction_date: "2026-07-15",
    merchant: "Test Merchant",
    amount_minor: 1000,
    currency: "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "needs_review",
    original_r2_key: "receipts/2026/07/r-1/f.jpg",
    original_sha256: "abc",
    original_content_type: "image/jpeg",
    original_size_bytes: 1024,
    processed_r2_key: null,
    extraction_json: null,
    legacy: 0,
    exported_month: null,
    expense_category_code: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    created_at: "2026-07-15T10:00:00Z",
    updated_at: "2026-07-15T10:00:00Z",
    ...overrides,
  };
}

test("signoff validator: no-receipt line uses line category", () => {
  const line = makeLine({
    matched_receipt_id: null,
    match_status: "no_receipt",
    receipt_status: "no_receipt_required",
    receipt_missing_reason: "lost",
    expense_category_code: "office_supplies",
  });
  const blockers = validateAmexLinesForSignoff([line], {}, new Map(), new Map());
  // Office supplies doesn't require attendees; line category is set; no blockers.
  assert.deepEqual(blockers, []);
});

test("signoff validator: no-receipt line with null line category still blocks", () => {
  const line = makeLine({
    matched_receipt_id: null,
    match_status: "no_receipt",
    receipt_status: "no_receipt_required",
    receipt_missing_reason: "lost",
    expense_category_code: null,
  });
  const blockers = validateAmexLinesForSignoff([line], {}, new Map(), new Map());
  assert.ok(blockers.some((b) => b.includes("missing expense category")));
});

test("signoff validator: receipt-linked line with null LINE category and categorized RECEIPT passes (dead-end fix)", () => {
  // The exact scenario the architect flagged: a receipt-linked line where
  // the line category was never set (and the new reconcile UI hides the
  // dropdown, so the user has no way to set it). The receipt has its own
  // category. Pre-fix this blocked signoff; post-fix it must pass.
  const line = makeLine({
    matched_receipt_id: "r-1",
    match_status: "confirmed",
    receipt_status: "matched",
    expense_category_code: null,
  });
  const receipt = makeReceipt({ id: "r-1", expense_category_code: "office_supplies" });
  const receiptMap = new Map([[receipt.id, receipt]]);

  const blockers = validateAmexLinesForSignoff(
    [line],
    {},
    new Map(),
    receiptMap,
  );
  assert.deepEqual(blockers, []);
});

test("signoff validator: receipt-linked line with categorized RECEIPT requiring attendees uses receipt attendees", () => {
  // Category trigger comes from the receipt (meeting requires attendees),
  // attendee names also come from the receipt. Must pass.
  const line = makeLine({
    matched_receipt_id: "r-1",
    match_status: "confirmed",
    receipt_status: "matched",
    expense_category_code: null,
  });
  const receipt = makeReceipt({ id: "r-1", expense_category_code: "meeting" });
  const receiptMap = new Map([[receipt.id, receipt]]);
  const receiptAttendeeMap = new Map([["r-1", ["Alice", "Bob"]]]);

  const blockers = validateAmexLinesForSignoff(
    [line],
    {},
    receiptAttendeeMap,
    receiptMap,
  );
  assert.deepEqual(blockers, []);
});

test("signoff validator: receipt-linked line with categorized RECEIPT but no attendees blocks on receipt category", () => {
  // Receipt category is `meeting` (requires attendees), no attendees on either
  // side. Blocker must fire (pre-fix this would have been missed when line
  // category was null — the trigger never fired).
  const line = makeLine({
    matched_receipt_id: "r-1",
    match_status: "confirmed",
    receipt_status: "matched",
    expense_category_code: null,
  });
  const receipt = makeReceipt({ id: "r-1", expense_category_code: "meeting" });
  const receiptMap = new Map([[receipt.id, receipt]]);

  const blockers = validateAmexLinesForSignoff(
    [line],
    {},
    new Map(),
    receiptMap,
  );
  assert.ok(blockers.some((b) => b.includes("requires attendees")));
});

test("signoff validator: dangling match (matched_receipt_id set, receipt missing) falls back to line", () => {
  // receipt_id set but the receipt isn't in the map (deleted out-of-band).
  // Don't invent a new error; use the line's category as fallback.
  const line = makeLine({
    matched_receipt_id: "r-gone",
    match_status: "confirmed",
    receipt_status: "matched",
    expense_category_code: "office_supplies",
  });
  // Empty receiptMap — receipt was deleted.
  const blockers = validateAmexLinesForSignoff([line], {}, new Map(), new Map());
  assert.deepEqual(blockers, []);
});

test("signoff validator: unmatched line still blocks on missing receipt confirmation regardless of category", () => {
  const line = makeLine({
    matched_receipt_id: null,
    match_status: "unmatched",
    receipt_status: "missing_receipt",
    expense_category_code: "office_supplies",
  });
  const blockers = validateAmexLinesForSignoff([line], {}, new Map(), new Map());
  // Should have at least: unresolved match status, missing receipt requires reason.
  assert.ok(blockers.length >= 2, `expected at least 2 blockers, got: ${JSON.stringify(blockers)}`);
});
