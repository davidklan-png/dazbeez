import test from "node:test";
import assert from "node:assert/strict";
import { computeReceiptChecks } from "@/lib/receipts/compliance";
import { COMPLIANCE_DEFAULTS } from "@/lib/receipts/settings";
import type {
  ComplianceSettings,
  ReceiptAttendee,
  ReceiptFile,
  ReceiptRecord,
} from "@/lib/receipts/types";

function baseReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  const now = "2026-05-01T00:00:00Z";
  return {
    id: "rec_1",
    captured_at: now,
    captured_by: "test",
    source: "mobile_capture",
    original_filename: "scan.jpg",
    payment_path: "CASH",
    expense_type: "UNKNOWN",
    transaction_date: "2026-05-01",
    merchant: "Test Merchant",
    amount_minor: 5000,
    currency: "JPY",
    tax_amount_minor: 500,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "needs_review",
    original_r2_key: "receipts/2026/05/rec_1/foo.jpg",
    original_sha256: "abc",
    original_content_type: "image/jpeg",
    original_size_bytes: 1024,
    processed_r2_key: null,
    extraction_json: null,
    legacy: 0,
    exported_month: null,
    expense_category_code: "supplies",
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    source_type: "paper_scanned",
    preservation_status: "needs_review",
    qualified_invoice_status: "not_checked",
    invoice_registration_number: "T1234567890123",
    invoice_registration_status: "format_valid",
    counterparty_name: "Test Merchant K.K.",
    tax_rate: "10%",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function originalFile(
  overrides: Partial<ReceiptFile> = {},
): ReceiptFile {
  return {
    id: "file_1",
    object_type: "receipt",
    object_id: "rec_1",
    role: "original",
    r2_bucket: "receipts",
    r2_key: "receipts/2026/05/rec_1/foo.jpg",
    original_filename: "scan.jpg",
    content_type: "image/jpeg",
    file_size_bytes: 1024,
    sha256_hash: "abc",
    uploaded_by: "test",
    uploaded_at: "2026-05-01T00:00:00Z",
    is_original: 1,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

const SETTINGS: ComplianceSettings = { ...COMPLIANCE_DEFAULTS };

test("compliance: fully populated receipt has no blockers", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt(),
    attendees: [],
    files: [originalFile()],
    settings: SETTINGS,
  });
  const blockers = checks.filter((c) => c.severity === "blocker");
  assert.equal(blockers.length, 0);
});

test("compliance: missing transaction_date is a blocker", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ transaction_date: null }),
    attendees: [],
    files: [originalFile()],
    settings: SETTINGS,
  });
  assert.ok(checks.some((c) => c.checkType === "missing_transaction_date"));
});

test("compliance: missing amount is a blocker", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ amount_minor: null }),
    attendees: [],
    files: [originalFile()],
    settings: SETTINGS,
  });
  const c = checks.find((x) => x.checkType === "missing_amount");
  assert.ok(c);
  assert.equal(c!.severity, "blocker");
});

test("compliance: missing category is a blocker", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ expense_category_code: null }),
    attendees: [],
    files: [originalFile()],
    settings: SETTINGS,
  });
  assert.ok(checks.some((c) => c.checkType === "missing_category"));
});

test("compliance: meeting expense without attendees blocks", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ expense_category_code: "meeting" }),
    attendees: [],
    files: [originalFile()],
    settings: SETTINGS,
  });
  const c = checks.find((x) => x.checkType === "missing_attendees");
  assert.ok(c);
  assert.equal(c!.severity, "blocker");
});

test("compliance: meeting expense with attendees passes", () => {
  const attendees: ReceiptAttendee[] = [
    {
      id: "a1",
      receipt_id: "rec_1",
      attendee_name: "Alice",
      company: null,
      relationship: null,
      is_dazbeez_employee: 0,
      notes: null,
      created_at: "2026-05-01T00:00:00Z",
    },
  ];
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ expense_category_code: "meeting" }),
    attendees,
    files: [originalFile()],
    settings: SETTINGS,
  });
  assert.equal(
    checks.find((c) => c.checkType === "missing_attendees"),
    undefined,
  );
});

test("compliance: missing invoice number warns when mode=warning", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ invoice_registration_number: null }),
    attendees: [],
    files: [originalFile()],
    settings: { ...SETTINGS, invoice_number_requirement_mode: "warning" },
  });
  const c = checks.find(
    (x) => x.checkType === "missing_invoice_registration_number",
  );
  assert.ok(c);
  assert.equal(c!.severity, "warning");
});

test("compliance: missing invoice number blocks when mode=blocker", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ invoice_registration_number: null }),
    attendees: [],
    files: [originalFile()],
    settings: { ...SETTINGS, invoice_number_requirement_mode: "blocker" },
  });
  const c = checks.find(
    (x) => x.checkType === "missing_invoice_registration_number",
  );
  assert.ok(c);
  assert.equal(c!.severity, "blocker");
});

test("compliance: invoice mode=disabled hides the check", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ invoice_registration_number: null }),
    attendees: [],
    files: [originalFile()],
    settings: { ...SETTINGS, invoice_number_requirement_mode: "disabled" },
  });
  assert.equal(
    checks.find((c) => c.checkType === "missing_invoice_registration_number"),
    undefined,
  );
});

test("compliance: electronic receipt with only image warns about original", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ source_type: "electronic_receipt" }),
    attendees: [],
    files: [originalFile({ content_type: "image/png" })],
    settings: SETTINGS,
  });
  const c = checks.find(
    (x) => x.checkType === "electronic_transaction_missing_original",
  );
  assert.ok(c);
  assert.equal(c!.severity, "warning");
});

test("compliance: electronic receipt with PDF original does not warn", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt({ source_type: "electronic_receipt" }),
    attendees: [],
    files: [originalFile({ content_type: "application/pdf" })],
    settings: SETTINGS,
  });
  assert.equal(
    checks.find(
      (c) => c.checkType === "electronic_transaction_missing_original",
    ),
    undefined,
  );
});

test("compliance: missing original file is a blocker", () => {
  const checks = computeReceiptChecks({
    receipt: baseReceipt(),
    attendees: [],
    files: [],
    settings: SETTINGS,
  });
  const c = checks.find((x) => x.checkType === "missing_receipt");
  assert.ok(c);
  assert.equal(c!.severity, "blocker");
});
