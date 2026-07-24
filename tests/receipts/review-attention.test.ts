import test from "node:test";
import assert from "node:assert/strict";
import {
  computeClosingAttentionReasons,
  computeClosingAttentionReceiptIds,
} from "@/lib/receipts/review-attention";
import type {
  AmexStatementLine,
  ReceiptRecord,
} from "@/lib/receipts/types";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";

// A clean receipt: reviewed, CASH, complete fields, no attendees required,
// has a proof file, no compliance flag, no AMEX line, not a duplicate, not an
// IC-card candidate. It must NOT appear in the attention set.
function makeReceipt(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    id: "r-clean",
    captured_at: "2026-07-10T10:00:00Z",
    captured_by: "test",
    source: "mobile_capture",
    original_filename: "r.jpg",
    payment_path: "CASH",
    expense_type: "misc",
    transaction_date: "2026-07-10",
    merchant: "Test Merchant",
    amount_minor: 1000,
    currency: "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: "reviewed",
    extraction_state: "processed",
    original_r2_key: "receipts/2026/07/r-clean/f.jpg",
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
    created_at: "2026-07-10T10:00:00Z",
    updated_at: "2026-07-10T10:00:00Z",
    ...overrides,
  } as ReceiptRecord;
}

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
  } as AmexStatementLine;
}

const DIR: ReceiptAttendeeDirectoryEntry[] = [
  { id: 1, company: "C", title: "T", name: "Alice" },
];
const EMPTY_DIR: ReceiptAttendeeDirectoryEntry[] = [];

const NOW = Date.UTC(2026, 6, 20);

/** Build the core input around a working set, with empty supporting data by
 *  default; each test overrides only what it needs. */
function input(
  receipts: ReceiptRecord[],
  overrides: Partial<Parameters<typeof computeClosingAttentionReceiptIds>[0]> = {},
) {
  return {
    receipts,
    now: NOW,
    amexLines: [],
    amexAttendees: {},
    receiptAttendeeMap: new Map<string, string[]>(),
    attendeeDirectory: EMPTY_DIR,
    complianceFlaggedReceiptIds: new Set<string>(),
    receiptFileCounts: new Map<string, number>([["r-clean", 1]]),
    crossMonthMatchedLines: [],
    ...overrides,
  };
}

function attentionFor(receipts: ReceiptRecord[], overrides?: Partial<Parameters<typeof computeClosingAttentionReceiptIds>[0]>) {
  return computeClosingAttentionReceiptIds(input(receipts, overrides));
}

function reasonsFor(receipts: ReceiptRecord[], overrides?: Partial<Parameters<typeof computeClosingAttentionReasons>[0]>) {
  return computeClosingAttentionReasons(input(receipts, overrides));
}

// ─── clean receipt is excluded ──────────────────────────────────────────────

test("attention: a clean reviewed receipt is NOT in the set", () => {
  const set = attentionFor([makeReceipt()]);
  assert.equal(set.has("r-clean"), false);
});

// ─── processing / stuck / failed ────────────────────────────────────────────

test("attention: pending processing (queued) is included", () => {
  const set = attentionFor([makeReceipt({ id: "p", extraction_state: "queued", status: "captured" })]);
  assert.equal(set.has("p"), true);
});

test("attention: extraction failed is included", () => {
  const set = attentionFor([makeReceipt({ id: "f", extraction_state: "failed" })]);
  assert.equal(set.has("f"), true);
});

// ─── unreviewed / unknown ───────────────────────────────────────────────────

test("attention: unreviewed (needs_review, not pending) is included", () => {
  const set = attentionFor([makeReceipt({ id: "u", status: "needs_review" })]);
  assert.equal(set.has("u"), true);
});

test("attention: UNKNOWN payment path is included", () => {
  const set = attentionFor([makeReceipt({ id: "unk", payment_path: "UNKNOWN" })]);
  assert.equal(set.has("unk"), true);
});

// ─── receipt-level closing gates ────────────────────────────────────────────

test("attention: missing transaction date is included", () => {
  const set = attentionFor(
    [makeReceipt({ id: "nodate", transaction_date: null })],
    { receiptFileCounts: new Map([["nodate", 1]]) },
  );
  assert.equal(set.has("nodate"), true);
});

test("attention: missing merchant is included", () => {
  const set = attentionFor(
    [makeReceipt({ id: "nomerchant", merchant: null })],
    { receiptFileCounts: new Map([["nomerchant", 1]]) },
  );
  assert.equal(set.has("nomerchant"), true);
});

test("attention: missing amount is included", () => {
  const set = attentionFor(
    [makeReceipt({ id: "noamount", amount_minor: null })],
    { receiptFileCounts: new Map([["noamount", 1]]) },
  );
  assert.equal(set.has("noamount"), true);
});

test("attention: missing expense category is included", () => {
  const set = attentionFor(
    [makeReceipt({ id: "nocat", expense_category_code: null })],
    { receiptFileCounts: new Map([["nocat", 1]]) },
  );
  assert.equal(set.has("nocat"), true);
});

test("attention: required attendees missing (meeting, none recorded) is included", () => {
  const set = attentionFor(
    [makeReceipt({ id: "noatt", expense_category_code: "meeting" })],
    { receiptFileCounts: new Map([["noatt", 1]]) },
  );
  assert.equal(set.has("noatt"), true);
});

test("attention: attendee not resolvable through the directory is included", () => {
  const set = attentionFor(
    [makeReceipt({ id: "ghost", expense_category_code: "meeting" })],
    {
      receiptAttendeeMap: new Map([["ghost", ["Alice", "UnknownPerson"]]]),
      attendeeDirectory: DIR, // resolves Alice, NOT UnknownPerson
      receiptFileCounts: new Map([["ghost", 1]]),
    },
  );
  assert.equal(set.has("ghost"), true);
});

test("attention: meeting with all attendees resolved is NOT flagged for attendees", () => {
  const set = attentionFor(
    [makeReceipt({ id: "okatt", expense_category_code: "meeting" })],
    {
      receiptAttendeeMap: new Map([["okatt", ["Alice"]]]),
      attendeeDirectory: DIR,
      receiptFileCounts: new Map([["okatt", 1]]),
    },
  );
  assert.equal(set.has("okatt"), false);
});

test("attention: no proof file row is included", () => {
  const set = attentionFor([makeReceipt({ id: "noproof" })], {
    receiptFileCounts: new Map(), // no rows for noproof
  });
  assert.equal(set.has("noproof"), true);
});

// ─── compliance ─────────────────────────────────────────────────────────────

test("attention: an open compliance warning is included (even when export_block_on_warnings is false)", () => {
  const set = attentionFor([makeReceipt({ id: "cw" })], {
    complianceFlaggedReceiptIds: new Set(["cw"]),
    receiptFileCounts: new Map([["cw", 1]]),
  });
  assert.equal(set.has("cw"), true);
});

// ─── AMEX sign-off rules ────────────────────────────────────────────────────

test("attention: AMEX receipt with re_review_needed line is included", () => {
  const line = makeLine({ id: "l1", matched_receipt_id: "amex1", re_review_needed: 1, expense_category_code: "supplies" });
  const set = attentionFor(
    [makeReceipt({ id: "amex1", payment_path: "AMEX" })],
    { amexLines: [line], receiptFileCounts: new Map([["amex1", 1]]) },
  );
  assert.equal(set.has("amex1"), true);
});

test("attention: AMEX receipt with unresolved (tentative) match is included", () => {
  const line = makeLine({ id: "l1", matched_receipt_id: "amex2", match_status: "matched", expense_category_code: "supplies" });
  const set = attentionFor(
    [makeReceipt({ id: "amex2", payment_path: "AMEX" })],
    { amexLines: [line], receiptFileCounts: new Map([["amex2", 1]]) },
  );
  assert.equal(set.has("amex2"), true);
});

test("attention: AMEX receipt whose line has unresolved business-trip candidate is included", () => {
  const line = makeLine({ id: "l1", matched_receipt_id: "amex3", business_trip_status: "candidate", expense_category_code: "supplies" });
  const set = attentionFor(
    [makeReceipt({ id: "amex3", payment_path: "AMEX" })],
    { amexLines: [line], receiptFileCounts: new Map([["amex3", 1]]) },
  );
  assert.equal(set.has("amex3"), true);
});

test("attention: AMEX receipt implicated by consolidated-line total mismatch is included", () => {
  const lineA = makeLine({ id: "la", matched_receipt_id: "hub", amount_minor: 2864, expense_category_code: "supplies" });
  const lineB = makeLine({ id: "lb", matched_receipt_id: "hub", amount_minor: 4185, expense_category_code: "supplies" });
  const set = attentionFor(
    [makeReceipt({ id: "hub", payment_path: "AMEX", amount_minor: 9999 })],
    { amexLines: [lineA, lineB], receiptFileCounts: new Map([["hub", 1]]) },
  );
  assert.equal(set.has("hub"), true);
});

test("attention: a confirmed, fully-clean AMEX match is NOT flagged", () => {
  const line = makeLine({ id: "l1", matched_receipt_id: "amexok", expense_category_code: "supplies" });
  const set = attentionFor(
    [makeReceipt({ id: "amexok", payment_path: "AMEX", expense_category_code: "supplies" })],
    { amexLines: [line], receiptFileCounts: new Map([["amexok", 1]]) },
  );
  assert.equal(set.has("amexok"), false);
});

test("attention: an AMEX-line issue with NO matched receipt does not fabricate a receipt id", () => {
  // unmatched line, no matched_receipt_id → stays on Reconcile, not the queue.
  const line = makeLine({ id: "l1", matched_receipt_id: null, match_status: "unmatched", receipt_status: "missing_receipt" });
  const set = attentionFor([makeReceipt()], { amexLines: [line] });
  assert.equal(set.size, 0);
});

// ─── cross-month ambiguous match ────────────────────────────────────────────

test("attention: a receipt matched to lines in two statement months is included", () => {
  const set = attentionFor([makeReceipt({ id: "xmonth", payment_path: "AMEX" })], {
    crossMonthMatchedLines: [
      { statement_month: "2026-06", matched_receipt_id: "xmonth" },
      { statement_month: "2026-07", matched_receipt_id: "xmonth" },
    ],
    receiptFileCounts: new Map([["xmonth", 1]]),
  });
  assert.equal(set.has("xmonth"), true);
});

// ─── duplicate cluster ──────────────────────────────────────────────────────

test("attention: every receipt in a possible-duplicate CASH/DIGITAL cluster is included", () => {
  const a = makeReceipt({ id: "dup1", merchant: "Seven-Eleven", amount_minor: 5000, transaction_date: "2026-07-10" });
  const b = makeReceipt({ id: "dup2", merchant: "Seven-Eleven", amount_minor: 5000, transaction_date: "2026-07-10" });
  const set = attentionFor([a, b], {
    receiptFileCounts: new Map([["dup1", 1], ["dup2", 1]]),
  });
  assert.equal(set.has("dup1"), true);
  assert.equal(set.has("dup2"), true);
});

// ─── IC-card top-up candidate ───────────────────────────────────────────────

test("attention: an IC-card top-up candidate is included", () => {
  const set = attentionFor(
    [makeReceipt({
      id: "ic",
      payment_path: "CASH",
      expense_category_code: "travel_transportation",
      amount_minor: 5000,
      merchant: "Seven-Eleven",
    })],
    { receiptFileCounts: new Map([["ic", 1]]) },
  );
  assert.equal(set.has("ic"), true);
});

// ─── membership is restricted to the working set ────────────────────────────

test("attention: only working-set ids are returned (a matched_receipt_id not in the set is ignored)", () => {
  const line = makeLine({ id: "l1", matched_receipt_id: "not-in-set", re_review_needed: 1, expense_category_code: "supplies" });
  const set = attentionFor([makeReceipt()], { amexLines: [line] });
  assert.equal(set.has("not-in-set"), false);
  assert.equal(set.size, 0);
});

// ─── reason codes (computeClosingAttentionReasons) ──────────────────────────

test("reasons: a clean receipt is ABSENT from the reasons map (not present with [])", () => {
  const map = reasonsFor([makeReceipt()]);
  assert.equal(map.has("r-clean"), false);
});

test("reasons: a receipt failing two gates carries both codes in check order", () => {
  // No date (gate 1) AND no proof-file row (gate 6) — both fire, in order.
  const map = reasonsFor(
    [makeReceipt({ id: "twogates", transaction_date: null })],
    { receiptFileCounts: new Map() },
  );
  assert.deepEqual(map.get("twogates"), ["missing_date", "missing_proof_file"]);
});

test("reasons: a pending receipt carries exactly ['extraction_pending'] even when it would also fail gates", () => {
  // Queued + every gate blank: the (1) skip must suppress the gate noise.
  const map = reasonsFor(
    [makeReceipt({
      id: "pend",
      extraction_state: "queued",
      status: "captured",
      transaction_date: null,
      merchant: null,
      amount_minor: null,
      expense_category_code: null,
    })],
    { receiptFileCounts: new Map() },
  );
  assert.deepEqual(map.get("pend"), ["extraction_pending"]);
});

test("reasons: AMEX sign-off maps to an amex_ code; the same code from two lines is deduped", () => {
  // Each confirmed line fires only re_review_needed → amex_re_review_needed;
  // two lines collapse to one deduped entry. (Line amounts sum to the receipt
  // total so no consolidated-mismatch code is also emitted.)
  const lineA = makeLine({ id: "la", matched_receipt_id: "ax", match_status: "confirmed", re_review_needed: 1, amount_minor: 500, expense_category_code: "supplies" });
  const lineB = makeLine({ id: "lb", matched_receipt_id: "ax", match_status: "confirmed", re_review_needed: 1, amount_minor: 500, expense_category_code: "supplies" });
  const map = reasonsFor(
    [makeReceipt({ id: "ax", payment_path: "AMEX" })],
    { amexLines: [lineA, lineB], receiptFileCounts: new Map([["ax", 1]]) },
  );
  assert.deepEqual(map.get("ax"), ["amex_re_review_needed"]);
});
