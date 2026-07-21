import test from "node:test";
import assert from "node:assert/strict";
import {
  crossMonthClaimedReceiptIds,
  allClaimedReceiptIds,
} from "@/lib/receipts/cross-month-claims";
import type { AmexStatementLine } from "@/lib/receipts/types";

function line(p: Partial<AmexStatementLine>): AmexStatementLine {
  return {
    id: p.id ?? "L1",
    statement_month: p.statement_month ?? "2026-08",
    transaction_date: p.transaction_date ?? "2026-07-01",
    posting_date: null,
    merchant: p.merchant ?? "M",
    amount_minor: p.amount_minor ?? 1000,
    currency: "JPY",
    amex_reference: null,
    matched_receipt_id: p.matched_receipt_id ?? null,
    match_status: p.match_status ?? "unmatched",
    raw_json: "{}",
    created_at: "2026-07-01T00:00:00Z",
    statement_artifact_id: null,
    cardholder_name: null,
    cardholder_flag: null,
    payment_type: null,
    prepayment_flag: null,
    memo: null,
    raw_csv_line_number: null,
    source_file_sha256: null,
    imported_at: "2026-07-01T00:00:00Z",
    expense_category: null,
    category_status: null,
    receipt_status: "missing_receipt",
    receipt_missing_reason: null,
    business_trip_id: null,
    business_trip_status: null,
    updated_at: "2026-07-01T00:00:00Z",
    expense_category_code: null,
    re_review_needed: 0,
    foreign_amount_minor: null,
    foreign_currency: null,
    foreign_exchange_rate: null,
    memo_currency_parse_status: null,
    ...p,
  } as AmexStatementLine;
}

// ─── crossMonthClaimedReceiptIds ─────────────────────────────────────────────

test("a confirmed line in another month marks the receipt cross-month-claimed", () => {
  const claims = [
    line({ id: "L-jul", statement_month: "2026-07", matched_receipt_id: "R-NFCTAGS", match_status: "confirmed" }),
    line({ id: "L-aug", statement_month: "2026-08", matched_receipt_id: "R-other", match_status: "confirmed" }),
  ];
  const out = crossMonthClaimedReceiptIds(claims, "2026-08");
  assert.deepEqual([...out], ["R-NFCTAGS"]); // R-other is in the displayed month → not included
});

test("same-month claims are NOT cross-month (consolidation stays available)", () => {
  const claims = [
    line({ statement_month: "2026-08", matched_receipt_id: "R1", match_status: "confirmed" }),
  ];
  assert.equal(crossMonthClaimedReceiptIds(claims, "2026-08").size, 0);
});

test("tentative (matched) cross-month claims also exclude; unmatched/no_receipt do not", () => {
  const claims = [
    line({ statement_month: "2026-07", matched_receipt_id: "R-tentative", match_status: "matched" }),
    line({ statement_month: "2026-07", matched_receipt_id: "R-stale", match_status: "unmatched" }),
    line({ statement_month: "2026-07", matched_receipt_id: "R-norec", match_status: "no_receipt" }),
  ];
  const out = crossMonthClaimedReceiptIds(claims, "2026-08");
  assert.deepEqual([...out], ["R-tentative"]);
});

// ─── allClaimedReceiptIds (badge wording source) ─────────────────────────────

test("allClaimedReceiptIds includes matched/confirmed across every month", () => {
  const claims = [
    line({ statement_month: "2026-07", matched_receipt_id: "A", match_status: "confirmed" }),
    line({ statement_month: "2026-08", matched_receipt_id: "B", match_status: "matched" }),
    line({ statement_month: "2026-08", matched_receipt_id: "C", match_status: "unmatched" }),
  ];
  assert.deepEqual([...allClaimedReceiptIds(claims)].sort(), ["A", "B"]);
});

// ─── Part B regression: the NFCTAGS shape (audit 2026-07-21) ──────────────────
// A receipt with status "reviewed", confirmed against a 2026-07 line, whose
// transaction_date (2026-06-08) falls inside 2026-08's padded window
// (2026-06-05..2026-07-15), MUST NOT appear as a 2026-08 match candidate or
// orphan. The page excludes it via crossMonthClaimedReceiptIds; this test pins
// that the exclusion set contains it and that filtering the candidate/orphan
// pools on the set removes it.

test("NFCTAGS regression: cross-month-confirmed receipt is excluded from 2026-08 candidates & orphans", () => {
  const displayedMonth = "2026-08";
  const nfctagsId = "8d71768d";
  // The receipt is dated 2026-06-08 — inside 2026-08's padded window
  // (min line 2026-06-10 − 5d = 2026-06-05 .. max 2026-07-10 + 5d = 2026-07-15).
  const nfctagsReceipt = { id: nfctagsId, transaction_date: "2026-06-08", status: "reviewed", payment_path: "AMEX" } as never;
  const windowedReceipts = [
    nfctagsReceipt,
    { id: "real-orphan", transaction_date: "2026-06-29", status: "reviewed", payment_path: "AMEX" } as never,
  ];

  // The authoritative signal: a confirmed 2026-07 line points at NFCTAGS.
  const claims = [
    line({ statement_month: "2026-07", matched_receipt_id: nfctagsId, match_status: "confirmed" }),
  ];
  const excluded = crossMonthClaimedReceiptIds(claims, displayedMonth);
  assert.ok(excluded.has(nfctagsId), "NFCTAGS must be in the cross-month exclusion set");

  // Matcher candidates & orphan pool both filter on the exclusion set (as the
  // page does). NFCTAGS drops out; the genuine in-period orphan remains.
  const candidates = windowedReceipts.filter((r) => !excluded.has((r as { id: string }).id));
  assert.equal(candidates.some((r) => (r as { id: string }).id === nfctagsId), false);
  assert.equal(candidates.some((r) => (r as { id: string }).id === "real-orphan"), true);
});
