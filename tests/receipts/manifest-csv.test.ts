import test from "node:test";
import assert from "node:assert/strict";
import { buildReconciliationManifestCsv } from "@/lib/receipts/reconciliation-signoff";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

function makeLine(overrides: Partial<AmexStatementLine> = {}): AmexStatementLine {
  return {
    id: "line-1",
    statement_month: "2024-01",
    transaction_date: "2024-01-15",
    posting_date: null,
    merchant: "AMAZON",
    amount_minor: 3800,
    currency: "JPY",
    amex_reference: "REF001",
    matched_receipt_id: "r-1",
    match_status: "confirmed",
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
    receipt_status: "matched",
    receipt_missing_reason: null,
    business_trip_id: null,
    business_trip_status: "not_applicable",
    expense_category_code: "office_supplies",
    re_review_needed: 0,
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
    amount_minor: 3800,
    currency: "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "needs_review",
    original_r2_key: "receipts/2024/01/r-1/file.jpg",
    original_sha256: "sha256abc",
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

test("manifest CSV includes attendees_amex and attendees_receipt columns", () => {
  const lines = [makeLine()];
  const receipts = [makeReceipt()];
  const amexAttendees = { "line-1": ["Alice", "Bob"] };
  const receiptAttendees = { "r-1": ["Carol"] };

  const csv = buildReconciliationManifestCsv(
    lines,
    receipts,
    amexAttendees,
    receiptAttendees,
  );

  const csvLines = csv.split("\n");
  assert.equal(csvLines.length, 2, "header + 1 data row");
  const headers = csvLines[0]!.split(",");
  assert.ok(headers.includes("attendees_amex"), "missing attendees_amex header");
  assert.ok(headers.includes("attendees_receipt"), "missing attendees_receipt header");

  const amexAttIdx = headers.indexOf("attendees_amex");
  const recAttIdx = headers.indexOf("attendees_receipt");
  const dataCols = csvLines[1]!.split(",");
  assert.equal(dataCols[amexAttIdx], "Alice; Bob");
  assert.equal(dataCols[recAttIdx], "Carol");
});

test("manifest CSV: missing attendees render as empty", () => {
  const lines = [makeLine({ matched_receipt_id: null })];
  const receipts = [makeReceipt()];
  const csv = buildReconciliationManifestCsv(lines, receipts, {}, {});

  const csvLines = csv.split("\n");
  const headers = csvLines[0]!.split(",");
  const amexAttIdx = headers.indexOf("attendees_amex");
  const recAttIdx = headers.indexOf("attendees_receipt");
  const dataCols = csvLines[1]!.split(",");
  assert.equal(dataCols[amexAttIdx], "");
  assert.equal(dataCols[recAttIdx], "");
});

test("manifest CSV: attendees with commas are escaped", () => {
  const lines = [makeLine()];
  const receipts = [makeReceipt()];
  const amexAttendees = { "line-1": ["Smith, Jr., John"] };

  const csv = buildReconciliationManifestCsv(lines, receipts, amexAttendees, {});

  // The raw CSV row must contain the escaped value
  const dataRow = csv.split("\n")[1]!;
  assert.ok(
    dataRow.includes('"Smith, Jr., John"'),
    "attendee with comma must be CSV-escaped",
  );
});
