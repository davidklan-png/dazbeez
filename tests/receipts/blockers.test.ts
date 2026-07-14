import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDuplicateBadgeMap,
  computeExportBlockers,
  computeDuplicateReceiptWarnings,
  computeIcCardTopUpWarnings,
  groupDuplicateReceipts,
  isIcCardTopUpCandidate,
  isTopUpVenueMerchant,
  type Blocker,
} from "@/lib/receipts/blockers";
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

// ─── IC-card top-up warning ────────────────────────────────────────────────
// Non-blocking advisory. All three signals (CASH/DIGITAL path +
// travel_transportation category + round top-up sum + top-up-venue merchant)
// must hold. Mirrors computeDuplicateReceiptWarnings surfacing.

test("ic-card warning: fires on the 4× ¥10,000 セブン-イレブン 06-11 prod cluster", () => {
  // Real prod case (2026-06): four CASH/DIGITAL travel_transportation
  // receipts, ¥10,000 each at セブン-イレブン (chain + branch suffix). Round
  // sum + top-up venue + travel category → all signals → one warning, count 4,
  // deep-linking to the first receipt.
  const receipts: ReceiptRecord[] = [0, 1, 2, 3].map((i) =>
    makeReceipt({
      id: `ic-${i}`,
      payment_path: i % 2 === 0 ? "CASH" : "DIGITAL",
      expense_category_code: "travel_transportation",
      merchant: "セブン-イレブン 東中野末広橋店",
      amount_minor: 10000,
      transaction_date: "2026-06-11",
    }),
  );

  const warnings = computeIcCardTopUpWarnings(receipts);
  assert.equal(
    warnings.length,
    1,
    `expected one IC-card warning, got: ${JSON.stringify(warnings)}`,
  );
  const w = warnings[0]!;
  assert.equal(w.severity, "warn");
  assert.equal(w.count, 4);
  assert.equal(w.label, "Possible IC-card top-ups (categorized as travel)");
  assert.equal(w.href, "/receipts/review/ic-0");
});

test("ic-card warning: does NOT fire on a ¥10,450 PC Depot charge (non-round, non-travel)", () => {
  // Fails on every signal: non-round amount (10450), non-travel category
  // (supplies), non-venue merchant. None of the three conditions hold.
  const receipts: ReceiptRecord[] = [
    makeReceipt({
      id: "pcd-1",
      payment_path: "CASH",
      expense_category_code: "supplies",
      merchant: "PC Depot",
      amount_minor: 10450,
      transaction_date: "2026-06-12",
    }),
  ];

  const warnings = computeIcCardTopUpWarnings(receipts);
  assert.equal(
    warnings.length,
    0,
    `expected no IC-card warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("ic-card warning: does NOT fire on a ¥1,900 EMot rail fare (actual usage, not a top-up venue)", () => {
  // Genuine travel expense: travel category + DIGITAL path, but neither a
  // round top-up sum (1900) nor a top-up venue (EMot). Real usage, not a
  // top-up, so the warning stays silent.
  const receipts: ReceiptRecord[] = [
    makeReceipt({
      id: "emot-1",
      payment_path: "DIGITAL",
      expense_category_code: "travel_transportation",
      merchant: "EMot",
      amount_minor: 1900,
      transaction_date: "2026-06-13",
    }),
  ];

  const warnings = computeIcCardTopUpWarnings(receipts);
  assert.equal(
    warnings.length,
    0,
    `expected no IC-card warning, got: ${JSON.stringify(warnings)}`,
  );
});

test("ic-card predicate: AMEX path is out of scope even with round sum + venue + travel", () => {
  // The trigger is CASH/DIGITAL receipts. An AMEX charge would surface as a
  // statement line, not a receipt — so an AMEX-path receipt is never a
  // candidate, regardless of the other signals.
  assert.equal(
    isIcCardTopUpCandidate({
      payment_path: "AMEX",
      expense_category_code: "travel_transportation",
      amount_minor: 10000,
      merchant: "セブン-イレブン",
    }),
    false,
  );
});

test("ic-card predicate: round ¥3,000 at a station + travel + CASH → candidate", () => {
  // 駅 (station) is a top-up-venue signal; ¥3,000 is a round top-up sum.
  assert.equal(
    isIcCardTopUpCandidate({
      payment_path: "CASH",
      expense_category_code: "travel_transportation",
      amount_minor: 3000,
      merchant: "新宿駅",
    }),
    true,
  );
});

test("ic-card predicate: round ¥5,000 travel charge at a non-venue merchant (taxi) → not a candidate", () => {
  assert.equal(
    isIcCardTopUpCandidate({
      payment_path: "CASH",
      expense_category_code: "travel_transportation",
      amount_minor: 5000,
      merchant: "日本交通タクシー",
    }),
    false,
  );
});

test("ic-card predicate: convenience store + round sum but non-travel category → not a candidate", () => {
  // Same venue + amount, but categorized as entertainment — the IC-card
  // hypothesis applies narrowly to travel_transportation.
  assert.equal(
    isIcCardTopUpCandidate({
      payment_path: "CASH",
      expense_category_code: "entertainment",
      amount_minor: 10000,
      merchant: "ローソン",
    }),
    false,
  );
});

// ─── merchant canonicalization (PR A) ──────────────────────────────────────
// The 2026-06 gaps: a PASMO top-up stored as the garble "セブンーエレブン"
// (540a5714) missed the IC venue list (IC warning counted 7, not 8) AND never
// clustered with its canonical-form re-photograph (0802caae) in the duplicate
// warning. Canonicalization at the read side fixes both.

test("ic-card venue: OCR-garbled セブンーエレブン now matches (undercount fix)", () => {
  // Before PR A this returned false (the garble contained neither "セブン-イレブン"
  // nor "セブンイレブン"), so receipt 540a5714 dropped out of the IC candidate
  // set and the warning undercounted. detectMerchantChain now recognizes it.
  assert.equal(isTopUpVenueMerchant("セブンーエレブン"), true);
  assert.equal(
    isIcCardTopUpCandidate({
      payment_path: "CASH",
      expense_category_code: "travel_transportation",
      amount_minor: 10000,
      merchant: "セブンーエレブン",
    }),
    true,
  );
});

test("duplicate warning: garble + canonical-form pair now clusters (June-2 fix)", () => {
  // Two photos of one ¥10,000 PASMO top-up on 2026-06-02. The merchant strings
  // differ in TWO ways (the ー/エ garble AND one carries the branch suffix), so
  // pre-canonicalization they had different grouping keys and never clustered.
  // Canonicalizing both to the セブン-イレブン token unifies the key.
  const receipts: ReceiptRecord[] = [
    makeReceipt({
      id: "g-1",
      payment_path: "CASH",
      expense_category_code: "travel_transportation",
      merchant: "セブンーエレブン",
      amount_minor: 10000,
      transaction_date: "2026-06-02",
    }),
    makeReceipt({
      id: "g-2",
      payment_path: "CASH",
      expense_category_code: "travel_transportation",
      merchant: "セブン-イレブン 東中野末広橋店",
      amount_minor: 10000,
      transaction_date: "2026-06-02",
    }),
  ];

  const warnings = computeDuplicateReceiptWarnings(receipts);
  assert.equal(
    warnings.length,
    1,
    `expected the June-2 pair to cluster, got: ${JSON.stringify(warnings)}`,
  );
  assert.equal(warnings[0]!.count, 2);
});

test("ic-card warning: the full 2026-06 candidate set counts as 8 (not 7)", () => {
  // Representative of the 8 prod receipts: garble, canonical, different branch,
  // different dates. All are CASH travel_transportation ¥10k at a セブン — all 8
  // must now register as IC candidates (the garble was the previous miss).
  const receipts: ReceiptRecord[] = [
    ["2026-06-02", "セブンーエレブン"],
    ["2026-06-02", "セブン-イレブン 東中野末広橋店"],
    ["2026-06-11", "セブン-イレブン 東中野末広橋店"],
    ["2026-06-11", "セブン-イレブン 東中野末広橋店"],
    ["2026-06-11", "セブン-イレブン 東中野末広橋店"],
    ["2026-06-11", "セブン-イレブン 東中野末広橋店"],
    ["2026-06-22", "セブン-イレブン 渋谷本町3丁目店"],
    ["2026-06-27", "セブン-イレブン 東中野末広橋店"],
  ].map(([date, merchant], i) =>
    makeReceipt({
      id: `ic8-${i}`,
      payment_path: "CASH",
      expense_category_code: "travel_transportation",
      merchant,
      amount_minor: 10000,
      transaction_date: date,
    }),
  );

  const warnings = computeIcCardTopUpWarnings(receipts);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0]!.count,
    8,
    `expected all 8 IC candidates, got: ${warnings[0]!.count}`,
  );
});

// ─── duplicate cluster membership + badges (PR B) ──────────────────────────

test("groupDuplicateReceipts: exposes cluster membership (ids only)", () => {
  // 4 receipts at the same canonical merchant + amount + date → one cluster of
  // 4. A receipt missing a date, and an AMEX-path receipt, are excluded.
  const cluster = [0, 1, 2, 3].map((i) =>
    makeReceipt({
      id: `m-${i}`,
      payment_path: "CASH",
      merchant: "セブン-イレブン 東中野末広橋店",
      amount_minor: 10000,
      transaction_date: "2026-06-11",
    }),
  );
  const noDate = makeReceipt({
    id: "m-nodate",
    payment_path: "CASH",
    merchant: "セブン-イレブン 東中野末広橋店",
    amount_minor: 10000,
    transaction_date: null,
  });
  const amex = makeReceipt({
    id: "m-amex",
    payment_path: "AMEX",
    merchant: "セブン-イレブン 東中野末広橋店",
    amount_minor: 10000,
    transaction_date: "2026-06-11",
  });

  const groups = groupDuplicateReceipts([...cluster, noDate, amex]);
  assert.equal(groups.length, 1, `expected one cluster, got: ${JSON.stringify(groups)}`);
  assert.equal(groups[0]!.ids.length, 4);
  assert.deepEqual(
    [...groups[0]!.ids].sort(),
    ["m-0", "m-1", "m-2", "m-3"],
  );
  // The dateless + AMEX receipts never appear in any cluster.
  const allIds = new Set(groups.flatMap((g) => g.ids));
  assert.equal(allIds.has("m-nodate"), false);
  assert.equal(allIds.has("m-amex"), false);
});

test("buildDuplicateBadgeMap: every clustered receipt → badge; unclustered absent", () => {
  // Two clusters: a pair (June-2 garble+canonical) and a triple (same merchant).
  const pair = [
    makeReceipt({ id: "p-1", payment_path: "CASH", merchant: "セブンーエレブン", amount_minor: 10000, transaction_date: "2026-06-02" }),
    makeReceipt({ id: "p-2", payment_path: "CASH", merchant: "セブン-イレブン 東中野末広橋店", amount_minor: 10000, transaction_date: "2026-06-02" }),
  ];
  const triple = [0, 1, 2].map((i) =>
    makeReceipt({ id: `t-${i}`, payment_path: "DIGITAL", merchant: "ローソン", amount_minor: 3000, transaction_date: "2026-06-15" }),
  );
  const lone = makeReceipt({ id: "lone-1", payment_path: "CASH", merchant: "PC Depot", amount_minor: 10450, transaction_date: "2026-06-12" });

  const map = buildDuplicateBadgeMap([...pair, ...triple, lone]);

  // Pair: both map to the cluster's first receipt (p-1), count 2.
  assert.deepEqual(map.get("p-1"), { firstId: "p-1", count: 2 });
  assert.deepEqual(map.get("p-2"), { firstId: "p-1", count: 2 });
  // Triple: all map to t-0, count 3.
  assert.deepEqual(map.get("t-0"), { firstId: "t-0", count: 3 });
  assert.deepEqual(map.get("t-2"), { firstId: "t-0", count: 3 });
  // The lone receipt is not in any cluster.
  assert.equal(map.has("lone-1"), false);
});

test("computeDuplicateReceiptWarnings: card behavior unchanged after refactor", () => {
  // The refactor extracted clusterDuplicates + groupDuplicateReceipts; the
  // aggregate card must still fire with the same count/label/href.
  const cluster = [0, 1, 2, 3].map((i) =>
    makeReceipt({
      id: `c-${i}`,
      payment_path: "CASH",
      merchant: "セブン-イレブン 東中野末広橋店",
      amount_minor: 10000,
      transaction_date: "2026-06-11",
    }),
  );
  const w = computeDuplicateReceiptWarnings(cluster);
  assert.equal(w.length, 1);
  assert.equal(w[0]!.count, 4);
  assert.equal(w[0]!.label, "Possible duplicate cash/digital receipts");
  assert.equal(w[0]!.href, "/receipts/review/c-0");
});
