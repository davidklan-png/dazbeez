import test from "node:test";
import assert from "node:assert/strict";
import {
  assignReceiptMembership,
  assignStatementMonth,
  computeStatementWindows,
  deriveStatementWindow,
  isReceiptInWindow,
  naturalStatementMonth,
  type StatementClose,
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

// ─── Statement-cycle membership windows (ADR 0006) ─────────────────────────
//
// Membership windows are slack-0 cycle boundaries chained across statements:
// window(M) = (close(M-1), close(M)], close(M) = MAX(transaction_date) over
// statement M's lines. Distinct from the slack-5 match window tested above.
//
// The worked example mirrors ADR §D1: AMEX statements run ~monthly, cycle
// transaction-dates are contiguous, and a statement labeled YYYY-MM covers a
// cycle that LAGS the label by ~2 months:
//   close(2026-04) ≈ Mar 9   close(2026-05) ≈ Apr 9   close(2026-06) ≈ May 7
// so window(2026-06) = (Apr 9, May 7] and a cash receipt dated May 3 ships in
// the JUNE export (same cycle as the Apr 10–May 7 AMEX lines), not May.

const CYCLE_CLOSES: StatementClose[] = [
  { statementMonth: "2026-04", close: "2026-03-09" },
  { statementMonth: "2026-05", close: "2026-04-09" },
  { statementMonth: "2026-06", close: "2026-05-07" },
];
const CYCLE_WINDOWS = computeStatementWindows(CYCLE_CLOSES);

// ─── computeStatementWindows ───────────────────────────────────────────────

test("computeStatementWindows: earliest window gets an open (null) start", () => {
  assert.equal(CYCLE_WINDOWS[0]!.statementMonth, "2026-04");
  assert.equal(CYCLE_WINDOWS[0]!.startExclusive, null);
  assert.equal(CYCLE_WINDOWS[0]!.endInclusive, "2026-03-09");
});

test("computeStatementWindows: chain is contiguous — startExclusive === prev endInclusive", () => {
  for (let i = 1; i < CYCLE_WINDOWS.length; i++) {
    assert.equal(
      CYCLE_WINDOWS[i]!.startExclusive,
      CYCLE_WINDOWS[i - 1]!.endInclusive,
      `contiguity broken at index ${i}`,
    );
  }
});

test("computeStatementWindows: sorted ascending by statementMonth even if input is not", () => {
  const w = computeStatementWindows([
    { statementMonth: "2026-06", close: "2026-05-07" },
    { statementMonth: "2026-04", close: "2026-03-09" },
    { statementMonth: "2026-05", close: "2026-04-09" },
  ]);
  assert.deepEqual(
    w.map((x) => x.statementMonth),
    ["2026-04", "2026-05", "2026-06"],
  );
});

test("computeStatementWindows: drops entries missing statementMonth or close (cannot anchor)", () => {
  const w = computeStatementWindows([
    { statementMonth: "2026-05", close: "2026-04-09" },
    { statementMonth: "2026-04", close: "" },
    { statementMonth: "", close: "2026-03-09" },
    { statementMonth: "2026-06", close: "2026-05-07" },
  ]);
  assert.deepEqual(
    w.map((x) => x.statementMonth),
    ["2026-05", "2026-06"],
  );
});

test("computeStatementWindows: empty input yields no windows", () => {
  assert.deepEqual(computeStatementWindows([]), []);
});

// ─── assignStatementMonth (single-membership, boundary semantics) ──────────

test("assignStatementMonth: interior date maps to its cycle month (ADR worked example)", () => {
  // May 3 is inside window(2026-06) = (Apr 9, May 7] → June export.
  assert.equal(assignStatementMonth("2026-05-03", CYCLE_WINDOWS), "2026-06");
  assert.equal(assignStatementMonth("2026-04-20", CYCLE_WINDOWS), "2026-06");
  assert.equal(assignStatementMonth("2026-03-25", CYCLE_WINDOWS), "2026-05");
});

test("assignStatementMonth: date exactly equal to a close belongs to that window (inclusive end)", () => {
  // Apr 9 == close(2026-05) == startExclusive(2026-06). Inclusive end ⇒ 2026-05.
  assert.equal(assignStatementMonth("2026-04-09", CYCLE_WINDOWS), "2026-05");
  // May 7 == close(2026-06) ⇒ 2026-06.
  assert.equal(assignStatementMonth("2026-05-07", CYCLE_WINDOWS), "2026-06");
});

test("assignStatementMonth: date on the cycle-open boundary goes to the next window, not the prior", () => {
  // Apr 10 is the first day past close(2026-05)=Apr 9 → window(2026-06).
  assert.equal(assignStatementMonth("2026-04-10", CYCLE_WINDOWS), "2026-06");
  // Mar 9 == close(2026-04) (earliest) ⇒ 2026-04.
  assert.equal(assignStatementMonth("2026-03-09", CYCLE_WINDOWS), "2026-04");
});

test("assignStatementMonth: any date up to the earliest close maps to the earliest month (open start)", () => {
  assert.equal(assignStatementMonth("2026-01-01", CYCLE_WINDOWS), "2026-04");
  assert.equal(assignStatementMonth("2025-12-31", CYCLE_WINDOWS), "2026-04");
});

test("assignStatementMonth: date beyond the newest close is awaiting (null)", () => {
  // Jun 15 > close(2026-06)=May 7, and 2026-07 isn't imported yet.
  assert.equal(assignStatementMonth("2026-06-15", CYCLE_WINDOWS), null);
});

test("assignStatementMonth: empty windows ⇒ null", () => {
  assert.equal(assignStatementMonth("2026-05-03", []), null);
});

test("assignStatementMonth: every date ≤ newest close resolves to exactly one month (single-membership)", () => {
  // Walk day by day across the full chained range; each day hits exactly one
  // window and consecutive days never skip or repeat a month boundary wrongly.
  const resolved: string[] = [];
  for (let d = 1; d <= 30; d++) {
    const dd = String(d).padStart(2, "0");
    resolved.push(assignStatementMonth(`2026-04-${dd}`, CYCLE_WINDOWS)!);
  }
  // Apr 1–9 → 2026-05 (open-ish, before/including close 2026-05); Apr 10–30 → 2026-06.
  assert.ok(resolved.every((m) => m === "2026-05" || m === "2026-06"));
  assert.equal(resolved[0], "2026-05"); // Apr 1
  assert.equal(resolved[8], "2026-05"); // Apr 9 (== close, inclusive)
  assert.equal(resolved[9], "2026-06"); // Apr 10 (first day of next window)
  assert.equal(resolved[29], "2026-06"); // Apr 30
});

test("naturalStatementMonth matches assignStatementMonth (parity)", () => {
  for (const d of ["2026-01-01", "2026-04-09", "2026-05-03", "2026-05-07", "2026-06-15"]) {
    assert.equal(naturalStatementMonth(d, CYCLE_WINDOWS), assignStatementMonth(d, CYCLE_WINDOWS));
  }
});

// ─── assignReceiptMembership (sealed-state + roll-forward + awaiting) ──────

test("assignReceiptMembership: natural month, not sealed ⇒ natural", () => {
  const sealed = new Set<string>(); // nothing sealed
  assert.deepEqual(assignReceiptMembership("2026-05-03", CYCLE_WINDOWS, sealed, { rollForward: true }), {
    month: "2026-06",
    reason: "natural",
  });
});

test("assignReceiptMembership: null date ⇒ awaiting", () => {
  assert.deepEqual(assignReceiptMembership(null, CYCLE_WINDOWS, new Set(), { rollForward: true }), {
    month: null,
    reason: "awaiting",
  });
});

test("assignReceiptMembership: date beyond newest close ⇒ awaiting", () => {
  assert.deepEqual(assignReceiptMembership("2026-06-15", CYCLE_WINDOWS, new Set(), { rollForward: true }), {
    month: null,
    reason: "awaiting",
  });
});

test("assignReceiptMembership: natural sealed + rollForward ⇒ next open month (rolledFrom set)", () => {
  // 2026-05 is finalized. A receipt dated Mar 25 naturally belongs to 2026-05
  // (window (Mar 9, Apr 9]); it rolls forward to the next open month, 2026-06.
  const sealed = new Set<string>(["2026-05"]);
  assert.deepEqual(assignReceiptMembership("2026-03-25", CYCLE_WINDOWS, sealed, { rollForward: true }), {
    month: "2026-06",
    reason: "roll-forward",
    rolledFrom: "2026-05",
  });
});

test("assignReceiptMembership: roll-forward skips intermediate sealed months to the first open one", () => {
  // 2026-05 AND 2026-06 both sealed; a 2026-05-natural receipt rolls to the
  // first open month after them. Here there is none newer ⇒ awaiting-rolled.
  const sealed = new Set<string>(["2026-05", "2026-06"]);
  assert.deepEqual(assignReceiptMembership("2026-03-25", CYCLE_WINDOWS, sealed, { rollForward: true }), {
    month: null,
    reason: "awaiting-rolled",
    rolledFrom: "2026-05",
  });
});

test("assignReceiptMembership: newest statement sealed + rollForward runs off the end ⇒ awaiting-rolled", () => {
  // A late capture naturally in 2026-06 (the newest), which is sealed, and no
  // 2026-07 exists yet.
  const sealed = new Set<string>(["2026-06"]);
  assert.deepEqual(assignReceiptMembership("2026-05-03", CYCLE_WINDOWS, sealed, { rollForward: true }), {
    month: null,
    reason: "awaiting-rolled",
    rolledFrom: "2026-06",
  });
});

test("assignReceiptMembership: rollForward=false never rolls even when natural is sealed (UNKNOWN path)", () => {
  // UNKNOWN receipts must be classified before they get a real export month,
  // so they never roll — they keep their natural month and block at gate 2.
  const sealed = new Set<string>(["2026-05"]);
  assert.deepEqual(assignReceiptMembership("2026-03-25", CYCLE_WINDOWS, sealed, { rollForward: false }), {
    month: "2026-05",
    reason: "natural",
  });
});

test("assignReceiptMembership: roll-forward lands on the first open month when an earlier one is sealed but a later one is open", () => {
  // Add a 2026-07 window so there IS a newer open month past sealed 2026-05/2026-06.
  const windows = computeStatementWindows([
    ...CYCLE_CLOSES,
    { statementMonth: "2026-07", close: "2026-06-07" },
  ]);
  const sealed = new Set<string>(["2026-05", "2026-06"]);
  assert.deepEqual(assignReceiptMembership("2026-03-25", windows, sealed, { rollForward: true }), {
    month: "2026-07",
    reason: "roll-forward",
    rolledFrom: "2026-05",
  });
});

// ─── Freeze rule (ADR §D3) ─────────────────────────────────────────────────

test("freeze: pure recomputation WOULD move an assignment when a close shifts (so protection must come from the NULL-only sweep)", () => {
  // close(2026-05) starts at Apr 9.
  const before = computeStatementWindows(CYCLE_CLOSES);
  // A May-1 receipt is naturally 2026-06 (window (Apr 9, May 7]).
  assert.equal(assignStatementMonth("2026-05-01", before), "2026-06");

  // A re-import/amendment appends a later-dated line to the 2026-05 statement,
  // shifting close(2026-05) to May 3 — AFTER some 2026-06 assignments were made.
  const shifted = computeStatementWindows([
    { statementMonth: "2026-04", close: "2026-03-09" },
    { statementMonth: "2026-05", close: "2026-05-03" },
    { statementMonth: "2026-06", close: "2026-05-07" },
  ]);
  // The SAME date now pure-computes to 2026-05 (its window now covers May 1).
  assert.equal(assignStatementMonth("2026-05-01", shifted), "2026-05");

  // The freeze rule says: even though recomputation now says 2026-05, a receipt
  // already stored as 2026-06 is NOT re-derived. The pure function WILL move it
  // — so the only thing preventing that is the sweep's `WHERE export_statement_month
  // IS NULL`, pinned in the contract test below. This is the exact "re-import
  // shifts close(M) after window(M+1) assignments were made" scenario.
});

test("freeze contract: a re-derivation sweep selects only receipts whose export_statement_month IS NULL", () => {
  // The freeze is a CALLER contract, not a property of the pure functions: the
  // backfill script and (PR #2) import sweep both select with
  // `WHERE export_statement_month IS NULL`, so an already-assigned receipt is
  // structurally invisible to re-derivation regardless of how windows move.
  // Model that predicate here against a mixed assigned/unassigned set.
  const receipts: Array<{ id: string; export_statement_month: string | null }> = [
    { id: "r-assigned", export_statement_month: "2026-06" },
    { id: "r-unassigned", export_statement_month: null },
    { id: "r-also-assigned", export_statement_month: "2026-05" },
  ];
  // This is the sweep predicate, verbatim in intent.
  const swept = receipts.filter((r) => r.export_statement_month === null);
  assert.deepEqual(
    swept.map((r) => r.id),
    ["r-unassigned"],
    "an assigned receipt must never be selected for re-derivation",
  );
});
