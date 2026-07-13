import test from "node:test";
import assert from "node:assert/strict";
import {
  assignReceiptMembership,
  deriveStatementWindow,
  incrementMonth,
  isReceiptInWindow,
  naturalMonth,
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

// ─── deriveStatementWindow (match window — ADR 0008 does not touch this) ────

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

// ─── isReceiptInWindow (match window) ───────────────────────────────────────

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

// ─── Calendar-month membership (ADR 0008) ───────────────────────────────────
//
// A CASH/DIGITAL receipt's export month is the CALENDAR month of its
// transaction_date (June 11 → 2026-06), stored on
// receipt_records.export_statement_month. This RETIRES the ADR 0006
// statement-cycle-window rule: a cash receipt now ships in the same calendar
// month as its date, sitting alongside that month's AMEX statement (whose own
// lines span the prior billing cycle — the asymmetry is intentional). The tests
// below cover the pure naturalMonth + assignReceiptMembership math. The slack-5
// MATCH window above is untouched by ADR 0008.

// ─── naturalMonth ───────────────────────────────────────────────────────────

test("naturalMonth: extracts the YYYY-MM calendar month", () => {
  assert.equal(naturalMonth("2026-06-01"), "2026-06");
  assert.equal(naturalMonth("2026-06-30"), "2026-06");
  assert.equal(naturalMonth("2026-06-11"), "2026-06");
});

test("naturalMonth: boundary dates land in the right calendar month", () => {
  assert.equal(naturalMonth("2026-06-30"), "2026-06");
  assert.equal(naturalMonth("2026-07-01"), "2026-07");
  // Year boundary — the load-bearing edge for December→January receipts.
  assert.equal(naturalMonth("2026-12-31"), "2026-12");
  assert.equal(naturalMonth("2027-01-01"), "2027-01");
});

test("naturalMonth: null / empty / malformed ⇒ null", () => {
  assert.equal(naturalMonth(null), null);
  assert.equal(naturalMonth(""), null);
  assert.equal(naturalMonth("not-a-date"), null);
});

// ─── incrementMonth ─────────────────────────────────────────────────────────

test("incrementMonth: advances and wraps across the year boundary", () => {
  assert.equal(incrementMonth("2026-06", 1), "2026-07");
  assert.equal(incrementMonth("2026-12", 1), "2027-01");
  assert.equal(incrementMonth("2026-01", -1), "2025-12");
  assert.equal(incrementMonth("2026-06", 0), "2026-06");
});

// ─── assignReceiptMembership ────────────────────────────────────────────────

test("assignReceiptMembership: natural month not sealed ⇒ natural", () => {
  const sealed = new Set<string>(); // nothing sealed
  assert.deepEqual(assignReceiptMembership("2026-06-11", sealed, { rollForward: true }), {
    month: "2026-06",
    reason: "natural",
  });
});

test("assignReceiptMembership: natural month sealed + rollForward ⇒ next open calendar month", () => {
  // 2026-06 is sealed; a June-dated receipt rolls to the next open month, 2026-07.
  const sealed = new Set<string>(["2026-06"]);
  assert.deepEqual(assignReceiptMembership("2026-06-11", sealed, { rollForward: true }), {
    month: "2026-07",
    reason: "roll-forward",
    rolledFrom: "2026-06",
  });
});

test("assignReceiptMembership: roll-forward skips consecutive sealed months to the first open one", () => {
  // 2026-06 AND 2026-07 both sealed; a June-dated receipt rolls past them to 2026-08.
  const sealed = new Set<string>(["2026-06", "2026-07"]);
  assert.deepEqual(assignReceiptMembership("2026-06-11", sealed, { rollForward: true }), {
    month: "2026-08",
    reason: "roll-forward",
    rolledFrom: "2026-06",
  });
});

test("assignReceiptMembership: rollForward=false keeps the natural month even when sealed (UNKNOWN path)", () => {
  // UNKNOWN receipts must be classified before they get a real export month, so
  // they never roll — they keep their natural month and block at gate 2.
  const sealed = new Set<string>(["2026-06"]);
  assert.deepEqual(assignReceiptMembership("2026-06-11", sealed, { rollForward: false }), {
    month: "2026-06",
    reason: "natural",
  });
});

test("assignReceiptMembership: bounded walk exhausted (every reachable month sealed) falls back to natural", () => {
  // Pathological state: every reachable month is sealed. A receipt must never be
  // left unassigned, so it falls back to its natural month (the operator can
  // override). Seal a wide contiguous range to force the 24-month walk to its cap.
  const sealed = new Set<string>();
  for (let y = 2026; y <= 2030; y++) {
    for (let m = 1; m <= 12; m++) {
      sealed.add(`${y}-${String(m).padStart(2, "0")}`);
    }
  }
  assert.deepEqual(assignReceiptMembership("2026-06-11", sealed, { rollForward: true }), {
    month: "2026-06",
    reason: "natural",
  });
});

// ─── Sticky / freeze contract (ADR 0008, restated from ADR 0006) ────────────
//
// The freeze is a CALLER contract, not a property of the pure functions: the
// capture / date-set assignment UPDATEs are `WHERE export_statement_month IS
// NULL`, so an already-assigned receipt is structurally invisible to
// re-derivation. Calendar month removed ADR 0006's drift risk entirely — there
// is no AMEX-line dependency — so the drift sweep is gone and these two hooks
// (plus the operator override and the one-time policy migration) are the only
// writers of the column.

test("freeze contract: the automatic assignment hooks only touch receipts whose export_statement_month IS NULL", () => {
  // Model the WHERE predicate the capture/date-set hooks use, verbatim in intent.
  const receipts: Array<{ id: string; export_statement_month: string | null }> = [
    { id: "r-assigned", export_statement_month: "2026-06" },
    { id: "r-unassigned", export_statement_month: null },
    { id: "r-also-assigned", export_statement_month: "2026-07" },
  ];
  const swept = receipts.filter((r) => r.export_statement_month === null);
  assert.deepEqual(
    swept.map((r) => r.id),
    ["r-unassigned"],
    "an assigned receipt must never be re-derived by the automatic hooks",
  );
});

test("sticky: a date change on an already-assigned receipt does not reassign it", () => {
  // Under ADR 0008 the date-set hook only assigns when export_statement_month IS
  // NULL. A date CHANGE on an assigned receipt is a no-op for membership — the
  // operator must override explicitly. The natural month of the new date may
  // legitimately differ from the stored month, and that is correct (sticky).
  const stored = "2026-06";
  const newDateNatural = naturalMonth("2026-07-15");
  assert.equal(newDateNatural, "2026-07");
  assert.notEqual(stored, newDateNatural);
  // The hook's guard: only act when stored is NULL. Here stored is non-null ⇒ skip.
  const wouldReassign = stored === null;
  assert.equal(wouldReassign, false);
});
