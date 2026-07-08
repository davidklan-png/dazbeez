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
  assert.ok(matches[0]!.matchReasons.includes("0-day window"));
});

test("known merchant alias (えきねっと ↔ 東日本旅客鉄道) reaches auto-confirm band", () => {
  const lines = [
    makeAmexLine({ merchant: "えきねっと", amount_minor: 4900, transaction_date: "2026-04-25" }),
  ];
  const receipts = [
    makeReceipt({
      merchant: "東日本旅客鉄道株式会社",
      amount_minor: 4900,
      transaction_date: "2026-04-25",
    }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.ok(
    matches[0]!.confidenceScore >= 0.92,
    `expected obvious-band score, got ${matches[0]!.confidenceScore}`,
  );
  assert.ok(matches[0]!.matchReasons.includes("known merchant alias"));
});

// ─── Consolidated receipts (multiple statement lines → one 領収書) ────────────

test("consolidated receipt: two same-merchant lines summing exactly to the receipt total are both matched to it", () => {
  const lines = [
    makeAmexLine({ id: "hub-1", merchant: "HUB 東京オペラシティ店", amount_minor: 2864, transaction_date: "2026-04-27" }),
    makeAmexLine({ id: "hub-2", merchant: "HUB 東京オペラシティ店", amount_minor: 4185, transaction_date: "2026-04-27" }),
  ];
  const receipts = [
    makeReceipt({ id: "r-hub", merchant: "HUB 東京オペラシティ店", amount_minor: 7049, transaction_date: "2026-04-27" }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 2);
  assert.ok(matches.every((m) => m.receiptId === "r-hub"));
  assert.ok(matches.every((m) => m.consolidatedGroupSize === 2));
  // Capped below the auto-confirm band (0.92) — a human confirms each group line.
  assert.ok(matches.every((m) => m.confidenceScore >= 0.7 && m.confidenceScore < 0.92));
  assert.ok(matches.every((m) => m.matchReasons.some((r) => r.includes("consolidated"))));
});

test("consolidated receipt: no group suggestion when the sum does not match exactly", () => {
  const lines = [
    makeAmexLine({ id: "e-1", merchant: "ENEOS", amount_minor: 3300, transaction_date: "2026-04-29" }),
    makeAmexLine({ id: "e-2", merchant: "ENEOS", amount_minor: 19470, transaction_date: "2026-04-29" }),
  ];
  const receipts = [
    makeReceipt({ id: "r-e", merchant: "ENEOS", amount_minor: 22771, transaction_date: "2026-04-29" }),
  ];
  assert.equal(matchAmexToReceipts(lines, receipts).length, 0);
});

test("consolidated receipt: a receipt with a 1:1 match is not also group-matched", () => {
  // Receipt equals one line exactly → 1:1 wins; the second line stays unmatched
  // rather than being pulled into a bogus group.
  const lines = [
    makeAmexLine({ id: "l-1", merchant: "ENEOS", amount_minor: 3300, transaction_date: "2026-04-29" }),
    makeAmexLine({ id: "l-2", merchant: "ENEOS", amount_minor: 19470, transaction_date: "2026-04-29" }),
  ];
  const receipts = [
    makeReceipt({ id: "r-single", merchant: "ENEOS", amount_minor: 3300, transaction_date: "2026-04-29" }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.amexLineId, "l-1");
  assert.equal(matches[0]!.consolidatedGroupSize, undefined);
});

test("consolidated receipt: remaining line is still suggested after the first line is confirmed", () => {
  // Confirming line 1 promotes the receipt to 'reconciled' and the page
  // refreshes — the second line must keep its suggestion (Codex P2).
  const lines = [
    makeAmexLine({
      id: "hub-1",
      merchant: "HUB 東京オペラシティ店",
      amount_minor: 2864,
      transaction_date: "2026-04-27",
      match_status: "confirmed",
      matched_receipt_id: "r-hub",
    }),
    makeAmexLine({
      id: "hub-2",
      merchant: "HUB 東京オペラシティ店",
      amount_minor: 4185,
      transaction_date: "2026-04-27",
    }),
  ];
  const receipts = [
    makeReceipt({
      id: "r-hub",
      merchant: "HUB 東京オペラシティ店",
      amount_minor: 7049,
      transaction_date: "2026-04-27",
      status: "reconciled",
    }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.amexLineId, "hub-2");
  assert.equal(matches[0]!.receiptId, "r-hub");
  assert.equal(matches[0]!.consolidatedGroupSize, 2);
});

test("consolidated receipt: fully-claimed receipt is not re-offered to leftover lines", () => {
  const lines = [
    makeAmexLine({
      id: "hub-1",
      merchant: "HUB 東京オペラシティ店",
      amount_minor: 7049,
      transaction_date: "2026-04-27",
      match_status: "confirmed",
      matched_receipt_id: "r-hub",
    }),
    makeAmexLine({
      id: "hub-3",
      merchant: "HUB 東京オペラシティ店",
      amount_minor: 1200,
      transaction_date: "2026-04-27",
    }),
  ];
  const receipts = [
    makeReceipt({
      id: "r-hub",
      merchant: "HUB 東京オペラシティ店",
      amount_minor: 7049,
      transaction_date: "2026-04-27",
      status: "reconciled",
    }),
  ];
  assert.equal(matchAmexToReceipts(lines, receipts).length, 0);
});

test("consolidated receipt: receipt reconciled by ANOTHER month's lines is not offered", () => {
  // status='reconciled' but no confirmed line in this month's set — the
  // claim lives elsewhere; do not offer it.
  const lines = [
    makeAmexLine({
      id: "hub-2",
      merchant: "HUB 東京オペラシティ店",
      amount_minor: 4185,
      transaction_date: "2026-04-27",
    }),
  ];
  const receipts = [
    makeReceipt({
      id: "r-hub",
      merchant: "HUB 東京オペラシティ店",
      amount_minor: 4185,
      transaction_date: "2026-04-27",
      status: "reconciled",
    }),
  ];
  assert.equal(matchAmexToReceipts(lines, receipts).length, 0);
});

test("consolidated receipt: lines outside the 7-day window are excluded from the group", () => {
  const lines = [
    makeAmexLine({ id: "n-1", merchant: "ENEOS", amount_minor: 3300, transaction_date: "2026-04-29" }),
    makeAmexLine({ id: "n-2", merchant: "ENEOS", amount_minor: 19470, transaction_date: "2026-06-15" }),
  ];
  const receipts = [
    makeReceipt({ id: "r-e", merchant: "ENEOS", amount_minor: 22770, transaction_date: "2026-04-29" }),
  ];
  // Group = only n-1 (single line) → below the 2-line minimum → no suggestion.
  assert.equal(matchAmexToReceipts(lines, receipts).length, 0);
});

test("no match when date is more than 7 days apart", () => {
  const lines = [makeAmexLine({ transaction_date: "2024-01-15" })];
  const receipts = [makeReceipt({ transaction_date: "2024-01-24" })];
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

test("reconciled receipts are excluded from matching", () => {
  const lines = [makeAmexLine()];
  const receipts = [makeReceipt({ status: "reconciled" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "reconciled receipts must not be matched");
});

test("needs_review and captured receipts remain eligible", () => {
  const lines = [
    makeAmexLine({ id: "line-a", transaction_date: "2024-01-15" }),
  ];
  const receipts = [
    makeReceipt({ id: "r-needs", status: "needs_review", transaction_date: "2024-01-15" }),
    makeReceipt({ id: "r-captured", status: "captured", transaction_date: "2024-01-15" }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1, "one of the eligible receipts should match");
  assert.ok(
    matches[0]!.receiptId === "r-needs" || matches[0]!.receiptId === "r-captured",
    "matched receipt should be either needs_review or captured",
  );
});

test("soft-deleted receipts are excluded from matching (defense-in-depth)", () => {
  const lines = [makeAmexLine()];
  const receipts = [makeReceipt({ deleted_at: "2024-01-20T00:00:00Z" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "soft-deleted receipts must not be matched");
});

// ─── Collision resolution ────────────────────────────────────────────────────

test("collision: two lines competing for one receipt — only one match returned", () => {
  const lines = [
    makeAmexLine({ id: "line-a", amount_minor: 380000, transaction_date: "2024-01-15" }),
    makeAmexLine({ id: "line-b", amount_minor: 380000, transaction_date: "2024-01-15" }),
  ];
  const receipts = [
    makeReceipt({ id: "r-1", amount_minor: 380000, transaction_date: "2024-01-15" }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1, "one receipt cannot satisfy two lines");
  // Tied on score and dateDelta → lexicographic line id wins: "line-a" < "line-b"
  assert.equal(matches[0]!.amexLineId, "line-a");
  assert.equal(matches[0]!.receiptId, "r-1");
});

test("no collision: two lines with distinct receipts — both matched", () => {
  const lines = [
    makeAmexLine({ id: "line-a", amount_minor: 380000, transaction_date: "2024-01-15" }),
    makeAmexLine({ id: "line-b", amount_minor: 200000, transaction_date: "2024-01-16" }),
  ];
  const receipts = [
    makeReceipt({ id: "r-x", amount_minor: 380000, transaction_date: "2024-01-15" }),
    makeReceipt({ id: "r-y", amount_minor: 200000, transaction_date: "2024-01-16" }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 2, "no collision — both lines should be matched");
  const matchA = matches.find((m) => m.amexLineId === "line-a");
  const matchB = matches.find((m) => m.amexLineId === "line-b");
  assert.ok(matchA, "line-a should have a match");
  assert.ok(matchB, "line-b should have a match");
  assert.equal(matchA!.receiptId, "r-x");
  assert.equal(matchB!.receiptId, "r-y");
});

test("contested receipt goes to higher-confidence line; loser gets no suggestion", () => {
  // line-a (2024-01-15) ↔ receipt X (2024-01-15): exact amount + same date = 0.85
  // line-b (2024-01-13) ↔ receipt X (2024-01-15): exact amount + 2-day window = 0.70
  // line-a also matches receipt Y at lower score, but its best is still X.
  // line-b cannot match receipt Y (date 5 days apart → rejected).
  const lines = [
    makeAmexLine({
      id: "line-a",
      amount_minor: 380000,
      transaction_date: "2024-01-15",
      merchant: "",
    }),
    makeAmexLine({
      id: "line-b",
      amount_minor: 380000,
      transaction_date: "2024-01-13",
      merchant: "",
    }),
  ];
  const receipts = [
    makeReceipt({
      id: "r-x",
      amount_minor: 380000,
      transaction_date: "2024-01-15",
      merchant: "",
    }),
    makeReceipt({
      id: "r-y",
      amount_minor: 381000,
      transaction_date: "2024-01-18",
      merchant: "",
    }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1, "receipt X goes to line-a; line-b unmatched");
  assert.equal(matches[0]!.amexLineId, "line-a");
  assert.equal(matches[0]!.receiptId, "r-x");
  assert.ok(matches[0]!.confidenceScore >= 0.8);
});

// ─── Null transaction_date handling ──────────────────────────────────────────

test("null transaction_date + exact amount → match possible but capped at 0.5", () => {
  const lines = [makeAmexLine({ transaction_date: "2024-01-15" })];
  const receipts = [makeReceipt({ transaction_date: null, merchant: null })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1, "dateless receipt with matching amount should still be a candidate");
  assert.ok(matches[0]!.confidenceScore <= 0.5, "confidence must be capped at 0.5 without a date");
  assert.ok(matches[0]!.matchReasons.includes("no date on receipt"));
});

test("both dates present + same amount → unchanged high confidence", () => {
  const lines = [makeAmexLine({ transaction_date: "2024-01-15" })];
  const receipts = [makeReceipt({ transaction_date: "2024-01-15" })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.confidenceScore >= 0.8, "full-date match should retain high confidence");
  assert.ok(!matches[0]!.matchReasons.includes("no date on receipt"));
});

// ─── Date gradient scoring ───────────────────────────────────────────────────

test("2-day delta scores between 0-day and 6-day", () => {
  const scoreForDays = (days: number) => {
    const base = "2024-01-15";
    const target = new Date(Date.UTC(2024, 0, 15 + days));
    const targetStr = target.toISOString().slice(0, 10);
    const lines = [makeAmexLine({ transaction_date: base, merchant: "" })];
    const receipts = [makeReceipt({ transaction_date: targetStr, merchant: "" })];
    const matches = matchAmexToReceipts(lines, receipts);
    assert.equal(matches.length, 1, `expected a match at ${days} days`);
    return matches[0]!.confidenceScore;
  };

  const score0 = scoreForDays(0);
  const score2 = scoreForDays(2);
  const score6 = scoreForDays(6);

  assert.ok(score0 > score2, `0-day score (${score0}) should exceed 2-day (${score2})`);
  assert.ok(score2 > score6, `2-day score (${score2}) should exceed 6-day (${score6})`);
});

test("8-day delta is rejected (> 7-day window)", () => {
  const lines = [makeAmexLine({ transaction_date: "2024-01-15", merchant: "" })];
  const receipts = [makeReceipt({ transaction_date: "2024-01-23", merchant: null })];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 0, "8-day gap should fall outside the 7-day window");
});

// ─── Unicode-aware normalizeDescription ───────────────────────────────────────

test("normalizeDescription: preserves Japanese characters, strips punctuation", () => {
  assert.equal(normalizeDescription("セブン-イレブン"), "セブン イレブン");
});

// ─── Tightened descriptionContains (merchant matching) ────────────────────────

test("Japanese merchant: セブンイレブン渋谷 matches セブンイレブン", () => {
  const lines = [
    makeAmexLine({
      merchant: "セブンイレブン渋谷",
      amount_minor: 1500,
      transaction_date: "2024-01-15",
    }),
  ];
  const receipts = [
    makeReceipt({
      merchant: "セブンイレブン",
      amount_minor: 1500,
      transaction_date: "2024-01-15",
    }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.matchReasons.includes("merchant match"));
});

test("single-token AMAZON matches multi-token AMAZON PRIME VIDEO", () => {
  const lines = [
    makeAmexLine({
      merchant: "AMAZON PRIME VIDEO",
      amount_minor: 1500,
      transaction_date: "2024-01-15",
    }),
  ];
  const receipts = [
    makeReceipt({
      merchant: "AMAZON",
      amount_minor: 1500,
      transaction_date: "2024-01-15",
    }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.matchReasons.includes("merchant match"));
});

test("single-token AMAZON matches AMAZON MARKETPLACE", () => {
  const lines = [
    makeAmexLine({
      merchant: "AMAZON MARKETPLACE",
      amount_minor: 380000,
      transaction_date: "2024-01-15",
    }),
  ];
  const receipts = [
    makeReceipt({
      merchant: "AMAZON",
      amount_minor: 380000,
      transaction_date: "2024-01-15",
    }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.matchReasons.includes("merchant match"));
});

test("STAR does not match STARBUCKS (substring too short for single-token rule)", () => {
  // "STAR" (len 4) is a substring of "STARBUCKS" but not an exact token, and
  // the substring-containment rule requires the shorter token to have len ≥ 5.
  const lines = [
    makeAmexLine({
      merchant: "STARBUCKS",
      amount_minor: 600,
      transaction_date: "2024-01-15",
    }),
  ];
  const receipts = [
    makeReceipt({
      merchant: "STAR",
      amount_minor: 600,
      transaction_date: "2024-01-15",
    }),
  ];
  const matches = matchAmexToReceipts(lines, receipts);
  // Match still occurs on amount+date, but merchant match must NOT be credited
  assert.equal(matches.length, 1);
  assert.ok(!matches[0]!.matchReasons.includes("merchant match"));
});
