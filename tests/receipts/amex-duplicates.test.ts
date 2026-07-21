import test from "node:test";
import assert from "node:assert/strict";
import { findAmexDuplicateCandidates } from "@/lib/receipts/amex-duplicates";
import type { ReceiptRecord } from "@/lib/receipts/types";

let n = 0;
function rc(partial: Partial<ReceiptRecord> & Pick<ReceiptRecord, "merchant" | "amount_minor" | "transaction_date">): ReceiptRecord {
  n += 1;
  return {
    id: partial.id ?? `r${n}`,
    captured_at: "2026-07-01T00:00:00Z",
    captured_by: "op",
    source: "mobile_capture",
    original_filename: null,
    payment_path: "AMEX",
    expense_type: "UNKNOWN",
    currency: partial.currency ?? "JPY",
    tax_amount_minor: null,
    business_purpose: null,
    alcohol_present: 0,
    attendees_required: 0,
    status: partial.status ?? "reviewed",
    original_r2_key: "k",
    original_sha256: "s" + n,
    original_content_type: "image/jpeg",
    original_size_bytes: 100,
    processed_r2_key: null,
    extraction_json: null,
    legacy: 0,
    exported_month: null,
    expense_category_code: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    ...partial,
  } as ReceiptRecord;
}

const NONE = new Set<string>();

// ─── Strong: same canonical merchant + currency + amount + date ──────────────

test("strong candidate: same merchant/amount/date orphan vs matched partner", () => {
  const orphan = rc({ id: "orphan-okadoku", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19" });
  const matched = rc({ id: "matched-okadoku", merchant: "岡芳商店", amount_minor: 3862, transaction_date: "2026-06-19", status: "reconciled" });
  const out = findAmexDuplicateCandidates([orphan], [orphan, matched], new Set([matched.id]));
  assert.equal(out.size, 1);
  const cand = out.get("orphan-okadoku")!;
  assert.equal(cand.length, 1);
  assert.equal(cand[0]!.strength, "strong");
  assert.equal(cand[0]!.otherReceiptId, "matched-okadoku");
  assert.equal(cand[0]!.otherMatched, true);
});

test("canonicalization: garbled conbini variant clusters with the canonical spelling (strong)", () => {
  // Two photos of one PASMO top-up: OCR-garbled "セブンーエレブン" vs "セブン-イレブン".
  const orphan = rc({ id: "o", merchant: "セブンーエレブン", amount_minor: 10000, transaction_date: "2026-06-20" });
  const partner = rc({ id: "p", merchant: "セブン-イレブン 東中野末広橋店", amount_minor: 10000, transaction_date: "2026-06-20" });
  const out = findAmexDuplicateCandidates([orphan], [orphan, partner], NONE);
  assert.equal(out.get("o")![0]!.strength, "strong");
});

// ─── Near: same currency/amount, ±1 day, differing merchant text ─────────────

test("near candidate: same amount + same date but differing merchant text", () => {
  // PERFECT (receipt) vs PBK四ッ谷/Air (descriptor) — same ¥14040 charge, 06-12.
  const orphan = rc({ id: "o-perfect", merchant: "PERFECT", amount_minor: 14040, transaction_date: "2026-06-12" });
  const matched = rc({ id: "m-pbk", merchant: "PBK四ッ谷/Air", amount_minor: 14040, transaction_date: "2026-06-12", status: "reconciled" });
  const out = findAmexDuplicateCandidates([orphan], [orphan, matched], new Set([matched.id]));
  const cand = out.get("o-perfect")!;
  assert.equal(cand[0]!.strength, "near");
  assert.equal(cand[0]!.otherMatched, true);
});

test("near candidate: same amount, 1 day apart, differing merchant", () => {
  const orphan = rc({ id: "o", merchant: "株式会社ファイン・ラベル", amount_minor: 5940, transaction_date: "2026-06-09" });
  const matched = rc({ id: "m", merchant: "NFCTAGS", amount_minor: 5940, transaction_date: "2026-06-08", status: "reconciled" });
  const out = findAmexDuplicateCandidates([orphan], [orphan, matched], new Set([matched.id]));
  assert.equal(out.get("o")![0]!.strength, "near");
});

// ─── Legitimacy: same-merchant ±1-day round-trips are NOT flagged ────────────

test("round-trip: two same-merchant ±1-day receipts matched to distinct lines are not duplicate orphans", () => {
  // JR outbound 06-26 + return 06-27, both reconciled to distinct AMEX lines.
  const outbound = rc({ id: "jr-out", merchant: "JR東日本 えきねっと", amount_minor: 4280, transaction_date: "2026-06-26", status: "reconciled" });
  const ret = rc({ id: "jr-ret", merchant: "JR東日本 えきねっと", amount_minor: 4280, transaction_date: "2026-06-27", status: "reconciled" });
  const matched = new Set([outbound.id, ret.id]);
  // They are matched → not orphans → no candidates produced at all.
  const outMatched = findAmexDuplicateCandidates([], [outbound, ret], matched);
  assert.equal(outMatched.size, 0);

  // Even if one somehow appears as an orphan, same merchant + ±1 day is NOT a
  // near candidate (near requires differing merchant text) nor strong (date
  // differs). It must not be mislabeled a duplicate.
  const outOrphan = findAmexDuplicateCandidates([outbound], [outbound, ret], new Set([ret.id]));
  assert.equal(outOrphan.size, 0);
});

// ─── Non-destruction / shape ─────────────────────────────────────────────────

test("undated or amount-less receipts produce no candidates", () => {
  const orphan = rc({ merchant: "X", amount_minor: 100, transaction_date: null });
  const partner = rc({ merchant: "X", amount_minor: 100, transaction_date: "2026-06-19" });
  const out = findAmexDuplicateCandidates([orphan], [orphan, partner], NONE);
  assert.equal(out.size, 0);
});

test("a receipt never candidates against itself", () => {
  const orphan = rc({ id: "solo", merchant: "Solo", amount_minor: 500, transaction_date: "2026-06-19" });
  const out = findAmexDuplicateCandidates([orphan], [orphan], NONE);
  assert.equal(out.size, 0);
});

test("different amounts never match", () => {
  const orphan = rc({ merchant: "M", amount_minor: 1000, transaction_date: "2026-06-19" });
  const partner = rc({ merchant: "M", amount_minor: 1001, transaction_date: "2026-06-19" });
  const out = findAmexDuplicateCandidates([orphan], [orphan, partner], NONE);
  assert.equal(out.size, 0);
});

test("HOLIDAY triple: case-only merchant variants all cluster as STRONG (each sees the other two)", () => {
  // The three prod re-captures: two "HOLIDAY…" and one "Holiday…" (case-only
  // difference). The strong key is case-insensitive (dupCanonKey), so all three
  // pair up as strong — none falls into the gap between strong and near.
  const a = rc({ id: "h1", merchant: "HOLIDAY SKY LOUNGE 新宿", amount_minor: 10680, transaction_date: "2026-06-06" });
  const b = rc({ id: "h2", merchant: "Holiday Sky Lounge 新宿", amount_minor: 10680, transaction_date: "2026-06-06" });
  const c = rc({ id: "h3", merchant: "HOLIDAY SKY LOUNGE 新宿", amount_minor: 10680, transaction_date: "2026-06-06" });
  const out = findAmexDuplicateCandidates([a, b, c], [a, b, c], NONE);
  for (const id of ["h1", "h2", "h3"]) {
    const cands = out.get(id)!;
    assert.equal(cands.length, 2, `${id} should see the other two`);
    assert.ok(cands.every((x) => x.strength === "strong"), `${id} candidates should all be strong`);
  }
  // The case-variant (h2) is explicitly flagged, not stranded badge-less.
  assert.ok(out.get("h2")!.some((x) => x.otherReceiptId === "h1"));
  assert.ok(out.get("h2")!.some((x) => x.otherReceiptId === "h3"));
});

test("strong key stays chain-aware: garbled conbini variants still cluster (case-insensitive canon)", () => {
  // dupCanonKey = canonicalize (fold chain) THEN lowercase. Two Seven-Eleven
  // spellings + a re-photo with a branch suffix all canonicalize to the chain
  // token, then lowercase — strong cluster, case-insensitive.
  const a = rc({ id: "s1", merchant: "セブンーエレブン", amount_minor: 10000, transaction_date: "2026-06-20" });
  const b = rc({ id: "s2", merchant: "セブン-イレブン 東中野末広橋店", amount_minor: 10000, transaction_date: "2026-06-20" });
  const out = findAmexDuplicateCandidates([a], [a, b], NONE);
  assert.equal(out.get("s1")![0]!.strength, "strong");
});
