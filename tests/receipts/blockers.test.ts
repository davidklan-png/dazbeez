import test from "node:test";
import assert from "node:assert/strict";
import { computeExportBlockers, type Blocker } from "@/lib/receipts/blockers";
import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

// Fixture builders mirror tests/receipts/reconciliation-signoff.test.ts so the
// shapes stay valid against AmexStatementLine / ReceiptRecord.

function makeLine(overrides: Partial<AmexStatementLine> = {}): AmexStatementLine {
  return {
    id: "line-1",
    statement_month: "2026-06",
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
    expense_category_code: null,
    re_review_needed: 0,
    updated_at: null,
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: "r-1",
    captured_at: "2026-06-15T10:00:00Z",
    captured_by: "test",
    source: "mobile_capture",
    original_filename: "r.jpg",
    payment_path: "AMEX",
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
    expense_category_code: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    created_at: "2026-06-15T10:00:00Z",
    updated_at: "2026-06-15T10:00:00Z",
    ...overrides,
  };
}

function uncategorizedCount(blockers: Blocker[]): number {
  const b = blockers.find((x) => x.label === "Uncategorized AMEX lines");
  return b ? b.count : 0;
}

test("blockers: matched line with category only on the receipt is NOT uncategorized", () => {
  // The exact false-positive the fix targets: the line's own category is null
  // (and the reconcile UI hides the dropdown for matched lines, so the operator
  // can't set it anyway), but the matched receipt carries the category. The
  // finalize gate (resolveLineCategory) accepts this; the tile must too.
  const line = makeLine({
    matched_receipt_id: "r-1",
    match_status: "confirmed",
    receipt_status: "matched",
    expense_category_code: null,
  });
  const receipt = makeReceipt({ id: "r-1", expense_category_code: "office_supplies" });

  const blockers = computeExportBlockers([receipt], [line]);
  assert.equal(
    uncategorizedCount(blockers),
    0,
    `expected 0 uncategorized, got: ${JSON.stringify(blockers)}`,
  );
});

test("blockers: matched line where receipt ALSO lacks a category IS uncategorized", () => {
  // Both null → genuinely unresolved. Don't let the fix swing too far the other
  // way and hide real gaps.
  const line = makeLine({
    matched_receipt_id: "r-1",
    match_status: "confirmed",
    receipt_status: "matched",
    expense_category_code: null,
  });
  const receipt = makeReceipt({ id: "r-1", expense_category_code: null });

  const blockers = computeExportBlockers([receipt], [line]);
  assert.equal(uncategorizedCount(blockers), 1);
});

test("blockers: unmatched no-receipt line with no category IS uncategorized", () => {
  // No matched receipt → authority is the line's own (null) category.
  const line = makeLine({
    matched_receipt_id: null,
    match_status: "no_receipt",
    receipt_status: "no_receipt_required",
    receipt_missing_reason: "lost",
    expense_category_code: null,
  });

  const blockers = computeExportBlockers([], [line]);
  assert.equal(uncategorizedCount(blockers), 1);
});

test("blockers: dangling match (receipt id set but receipt absent) falls back to line category", () => {
  // matched_receipt_id points at a receipt not in the bundle (deleted
  // out-of-band). resolveLineCategory falls back to the line's own category,
  // matching the finalize gate — not uncategorized here.
  const line = makeLine({
    matched_receipt_id: "r-gone",
    match_status: "confirmed",
    receipt_status: "matched",
    expense_category_code: "office_supplies",
  });

  const blockers = computeExportBlockers([], [line]);
  assert.equal(uncategorizedCount(blockers), 0);
});

test("blockers: line matched to a receipt dated a DIFFERENT month resolves via matchedReceipts", () => {
  // The 2026-06 bug: the matched receipt is dated 2026-04, so it is absent
  // from the month-scoped `receipts` set the page used to pass alone. With the
  // matchedReceipts param (the ID-fetched set the finalize gate uses), the
  // line's category resolves from the receipt and is NOT uncategorized.
  const line = makeLine({
    matched_receipt_id: "r-apr",
    match_status: "confirmed",
    receipt_status: "matched",
    expense_category_code: null,
  });
  // The matched receipt is NOT in the month-scoped receipts array...
  const monthReceipts: ReceiptRecord[] = [];
  // ...but IS supplied via matchedReceipts, carrying a category.
  const matchedReceipts = [
    makeReceipt({
      id: "r-apr",
      transaction_date: "2026-04-20",
      expense_category_code: "office_supplies",
    }),
  ];

  const blockers = computeExportBlockers(monthReceipts, [line], matchedReceipts);
  assert.equal(
    uncategorizedCount(blockers),
    0,
    `expected 0 uncategorized with matchedReceipts, got: ${JSON.stringify(blockers)}`,
  );

  // Contrast: without matchedReceipts the same line IS uncategorized — the
  // param is what resolves it.
  const withoutFix = computeExportBlockers(monthReceipts, [line]);
  assert.equal(uncategorizedCount(withoutFix), 1);
});

test("blockers: receipt with unknown payment path is reported (finalize gate 2)", () => {
  // The finalize gate blocks on payment_path='UNKNOWN' (the receipt is
  // excluded from the bundle because its export month is ambiguous). The tile
  // must surface the same blocker so a month can't read "clear" yet 422 on
  // finalize.
  const receipt = makeReceipt({ id: "r-unk", payment_path: "UNKNOWN" });

  const blockers = computeExportBlockers([receipt], []);
  const unknown = blockers.find(
    (b) => b.label === "Receipts with unknown payment path",
  );
  assert.ok(unknown, `expected an unknown-payment-path blocker, got: ${JSON.stringify(blockers)}`);
  assert.equal(unknown!.count, 1);
});

test("blockers: needs_review receipt (not pending) is an unreviewed blocker with a status deep-link", () => {
  // The finalize gate now mirrors this (validateMonthReadyForExport gate 2.5),
  // so the tile's BLOCKER label is true. The href deep-links into a
  // status-filtered Review view.
  const receipt = makeReceipt({ id: "r-needs", status: "needs_review" });

  const blockers = computeExportBlockers([receipt], []);
  const unreviewed = blockers.find((b) => b.label === "Unreviewed receipts");
  assert.ok(unreviewed, `expected an unreviewed blocker, got: ${JSON.stringify(blockers)}`);
  assert.equal(unreviewed!.count, 1);
  assert.equal(unreviewed!.href, "/receipts/review?status=needs_review");
});

test("blockers: needs_review receipt still pending processing is NOT unreviewed", () => {
  // isPendingProcessing wins: a needs_review receipt still in the extraction
  // queue is surfaced as "pending processing", not "unreviewed" — the fix is
  // to drain the queue, not to review. The finalize gate mirrors this
  // exclusion (gate 2.5 skips isPendingProcessing rows).
  const receipt = makeReceipt({
    id: "r-pending",
    status: "needs_review",
    extraction_state: "queued",
  });

  const blockers = computeExportBlockers([receipt], []);
  const unreviewed = blockers.find((b) => b.label === "Unreviewed receipts");
  assert.equal(
    unreviewed ?? null,
    null,
    `expected no unreviewed blocker for a pending receipt, got: ${JSON.stringify(blockers)}`,
  );
});
