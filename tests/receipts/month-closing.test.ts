import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMonthReadyForExportCore,
  type ExportBundle,
  type ValidateMonthReadyInput,
} from "@/lib/receipts/month-closing";
import type {
  AmexReconciliation,
  AmexStatementLine,
  ReceiptRecord,
} from "@/lib/receipts/types";

const MONTH = "2026-06";

function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: "r-1",
    captured_at: "2026-06-15T10:00:00Z",
    captured_by: "test",
    source: "mobile_capture",
    original_filename: "r.jpg",
    payment_path: "CASH",
    expense_type: "misc",
    transaction_date: "2026-06-15",
    merchant: "Test Merchant",
    amount_minor: 1000,
    currency: "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "reviewed",
    original_r2_key: "receipts/2026/06/r-1/f.jpg",
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
    created_at: "2026-06-15T10:00:00Z",
    updated_at: "2026-06-15T10:00:00Z",
    ...overrides,
  };
}

function makeLine(overrides: Partial<AmexStatementLine> = {}): AmexStatementLine {
  return {
    id: "line-1",
    statement_month: MONTH,
    transaction_date: "2026-06-15",
    posting_date: null,
    merchant: "TEST MERCHANT",
    amount_minor: 1000,
    currency: "JPY",
    amex_reference: "REF001",
    matched_receipt_id: null,
    match_status: "confirmed",
    raw_json: "{}",
    created_at: "2026-06-15T00:00:00Z",
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
    expense_category_code: "supplies",
    re_review_needed: 0,
    updated_at: null,
    ...overrides,
  };
}

function makeReconciliation(overrides: Partial<AmexReconciliation> = {}): AmexReconciliation {
  return {
    id: "recon-1",
    statement_month: MONTH,
    statement_artifact_id: null,
    status: "finalized",
    manifest_r2_key: "manifests/2026-06.csv",
    manifest_sha256: "sha",
    line_count: 1,
    matched_count: 1,
    no_receipt_count: 0,
    created_by: "test",
    created_at: "2026-06-15T00:00:00Z",
    finalized_by: "test",
    finalized_at: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

function makeBundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    rows: [],
    receipts: [],
    amexLines: [],
    attendeeMap: new Map(),
    items: [],
    ...overrides,
  };
}

/** Clean input: every gate silent → core returns []. */
function makeInput(overrides: Partial<ValidateMonthReadyInput> = {}): ValidateMonthReadyInput {
  return {
    month: MONTH,
    reconciliation: makeReconciliation(),
    bundle: makeBundle(),
    unknownReceipts: [],
    unreviewedReceipts: [],
    amexAttendees: {},
    complianceSummary: { blockers: 0, warnings: 0 },
    complianceSettings: { export_block_on_warnings: false },
    crossMonthMatchedLines: [],
    ...overrides,
  };
}

test("gate core: clean input returns no blockers", () => {
  assert.deepEqual(validateMonthReadyForExportCore(makeInput()), []);
});

// (1) Statement-sealed
test("gate 1: missing reconciliation blocks", () => {
  const blockers = validateMonthReadyForExportCore(makeInput({ reconciliation: null }));
  assert.equal(
    blockers.some((b) => b.startsWith("No finalized reconciliation for 2026-06")),
    true,
  );
});

// (2) UNKNOWN payment_path
test("gate 2: UNKNOWN payment_path receipts block", () => {
  const blockers = validateMonthReadyForExportCore(
    makeInput({ unknownReceipts: [{ id: "r-unk", merchant: "DAISO" }] }),
  );
  assert.ok(
    blockers.some((b) => b.includes("DAISO") && b.includes("payment_path is UNKNOWN")),
    JSON.stringify(blockers),
  );
});

// (2.5) Unreviewed, incl. isPendingProcessing exclusion
test("gate 2.5: needs_review receipt (not pending) blocks; pending is excluded", () => {
  const blocking = validateMonthReadyForExportCore(
    makeInput({
      unreviewedReceipts: [makeReceipt({ id: "r-needs", status: "needs_review", merchant: "LAWSON" })],
    }),
  );
  assert.ok(
    blocking.some((b) => b.includes("LAWSON") && b.includes("unreviewed")),
    JSON.stringify(blocking),
  );

  // A needs_review receipt still in the extraction queue is "pending
  // processing", not "unreviewed" — must NOT block here.
  const pending = validateMonthReadyForExportCore(
    makeInput({
      unreviewedReceipts: [
        makeReceipt({ id: "r-pend", status: "needs_review", extraction_state: "queued" }),
      ],
    }),
  );
  assert.ok(
    !pending.some((b) => b.includes("unreviewed")),
    `pending needs_review must not produce an unreviewed blocker: ${JSON.stringify(pending)}`,
  );
});

// (3) Receipt-level (CASH/DIGITAL) field completeness
test("gate 3: CASH receipt missing expense category blocks; AMEX is skipped here", () => {
  const blockers = validateMonthReadyForExportCore(
    makeInput({
      bundle: makeBundle({
        receipts: [makeReceipt({ id: "r-cash", payment_path: "CASH", expense_category_code: null })],
      }),
    }),
  );
  assert.ok(
    blockers.some((b) => b.includes("r-cash") && b.includes("missing expense category")),
    JSON.stringify(blockers),
  );

  // AMEX receipts are validated via the line checks (gate 4), not here.
  const amex = validateMonthReadyForExportCore(
    makeInput({
      bundle: makeBundle({
        receipts: [makeReceipt({ id: "r-amex", payment_path: "AMEX", expense_category_code: null })],
      }),
    }),
  );
  assert.ok(
    !amex.some((b) => b.includes("r-amex") && b.includes("missing expense category")),
    `AMEX receipt must not hit gate 3: ${JSON.stringify(amex)}`,
  );
});

// (4) AMEX-line checks (validateAmexLinesForSignoff)
test("gate 4: unresolved AMEX line blocks via validateAmexLinesForSignoff", () => {
  const blockers = validateMonthReadyForExportCore(
    makeInput({
      bundle: makeBundle({
        amexLines: [makeLine({ match_status: "unmatched", merchant: "UNMATCHED CO" })],
      }),
    }),
  );
  assert.ok(
    blockers.some((b) => b.includes("UNMATCHED CO") && b.includes("unresolved match status")),
    JSON.stringify(blockers),
  );
  // NOTE: the consolidated-receipt sum rule (≥2 confirmed lines sharing a
  // receipt must sum to the receipt total) lives in validateAmexLinesForSignoff
  // and is covered by tests/receipts/reconciliation-signoff.test.ts.
});

// (5) Compliance
test("gate 5: compliance blockers and (optional) warnings block", () => {
  const withBlockers = validateMonthReadyForExportCore(
    makeInput({ complianceSummary: { blockers: 2, warnings: 0 } }),
  );
  assert.ok(withBlockers.some((b) => b.includes("2 open compliance blocker(s)")));

  const withWarnings = validateMonthReadyForExportCore(
    makeInput({
      complianceSummary: { blockers: 0, warnings: 1 },
      complianceSettings: { export_block_on_warnings: true },
    }),
  );
  assert.ok(withWarnings.some((b) => b.includes("1 open compliance warning(s)")));

  // Warnings don't block when export_block_on_warnings is false.
  const warningsOff = validateMonthReadyForExportCore(
    makeInput({
      complianceSummary: { blockers: 0, warnings: 1 },
      complianceSettings: { export_block_on_warnings: false },
    }),
  );
  assert.ok(!warningsOff.some((b) => b.includes("compliance warning")));
});

// (6) Cross-month match integrity
test("gate 6: receipt matched across months blocks only when this month is implicated", () => {
  const blocking = validateMonthReadyForExportCore(
    makeInput({
      crossMonthMatchedLines: [
        { statement_month: "2026-06", matched_receipt_id: "r-x" },
        { statement_month: "2026-07", matched_receipt_id: "r-x" },
      ],
    }),
  );
  assert.ok(
    blocking.some((b) => b.includes("r-x") && b.includes("multiple statement months")),
    JSON.stringify(blocking),
  );

  // Two months but neither is the one being finalized → no blocker.
  const otherMonths = validateMonthReadyForExportCore(
    makeInput({
      month: "2026-06",
      crossMonthMatchedLines: [
        { statement_month: "2026-07", matched_receipt_id: "r-y" },
        { statement_month: "2026-08", matched_receipt_id: "r-y" },
      ],
    }),
  );
  assert.ok(!otherMonths.some((b) => b.includes("r-y")));

  // Only one month → not ambiguous → no blocker.
  const single = validateMonthReadyForExportCore(
    makeInput({
      crossMonthMatchedLines: [{ statement_month: "2026-06", matched_receipt_id: "r-z" }],
    }),
  );
  assert.ok(!single.some((b) => b.includes("r-z")));
});
