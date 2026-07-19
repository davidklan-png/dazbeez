import test from "node:test";
import assert from "node:assert/strict";
import {
  parseForeignCurrencyMemo,
  parseExchangeRateMemo,
  foreignAmountCrossCheckOk,
  toMinorUnits,
} from "@/lib/receipts/foreign-currency";

// Real operator-screenshot rows (2026-06/07 SAISON statement) are used verbatim
// as the primary fixtures — not synthetic strings — per the worker spec §6.

// ─── parseForeignCurrencyMemo: real charge-row memos (verbatim) ──────────────

test("parseForeignCurrencyMemo: 2026/06/11 CLOUDFLARE 現地通貨額:11.51 USD", () => {
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:11.51 USD"), {
    status: "parsed",
    amountMinor: 1151,
    currency: "USD",
  });
});

test("parseForeignCurrencyMemo: 2026/06/23 ANTHROPIC 現地通貨額:66.00 USD", () => {
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:66.00 USD"), {
    status: "parsed",
    amountMinor: 6600,
    currency: "USD",
  });
});

test("parseForeignCurrencyMemo: 2026/07/04 CLOUDFLARE 現地通貨額:3.30 USD", () => {
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:3.30 USD"), {
    status: "parsed",
    amountMinor: 330,
    currency: "USD",
  });
});

// ─── Variants ───────────────────────────────────────────────────────────────

test("parseForeignCurrencyMemo: full-width colon variant", () => {
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額：12.34 EUR"), {
    status: "parsed",
    amountMinor: 1234,
    currency: "EUR",
  });
});

test("parseForeignCurrencyMemo: comma-thousands amount", () => {
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:1,234.56 USD"), {
    status: "parsed",
    amountMinor: 123456,
    currency: "USD",
  });
});

test("parseForeignCurrencyMemo: lowercase currency code is uppercased", () => {
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:11.51 usd"), {
    status: "parsed",
    amountMinor: 1151,
    currency: "USD",
  });
});

test("parseForeignCurrencyMemo: marker present but garbled → unparsed", () => {
  // amount missing
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:USD"), { status: "unparsed" });
  // currency missing
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:12.50"), { status: "unparsed" });
  // currency code not 3 letters
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:12.50 DOLLARS"), {
    status: "unparsed",
  });
  // non-numeric amount
  assert.deepEqual(parseForeignCurrencyMemo("現地通貨額:一二三 USD"), {
    status: "unparsed",
  });
});

test("parseForeignCurrencyMemo: no marker → none (behaves as ordinary JPY line)", () => {
  assert.deepEqual(parseForeignCurrencyMemo(null), { status: "none" });
  assert.deepEqual(parseForeignCurrencyMemo(""), { status: "none" });
  assert.deepEqual(parseForeignCurrencyMemo("some ordinary memo"), { status: "none" });
  assert.deepEqual(parseForeignCurrencyMemo("円換算レート:6/11 166.6377"), {
    status: "none",
  });
});

// ─── parseExchangeRateMemo: real continuation-row memos (verbatim) ───────────

test("parseExchangeRateMemo: real continuation rows", () => {
  assert.equal(parseExchangeRateMemo("円換算レート:6/11 166.6377"), 166.6377);
  assert.equal(parseExchangeRateMemo("円換算レート:6/23 168.1516"), 168.1516);
  assert.equal(parseExchangeRateMemo("円換算レート:7/04 167.2728"), 167.2728);
});

test("parseExchangeRateMemo: null / no marker / unparseable → null", () => {
  assert.equal(parseExchangeRateMemo(null), null);
  assert.equal(parseExchangeRateMemo("(SAN FRANCISCO)"), null);
  assert.equal(parseExchangeRateMemo("円換算レート:abc"), null);
});

// ─── Cross-check: rate × foreign amount ≈ JPY total within ±1 yen ───────────

test("foreignAmountCrossCheckOk: real rows pass (within ±1 yen)", () => {
  // 11.51 × 166.6377 = 1918.06 → ¥1918 ✓
  assert.equal(
    foreignAmountCrossCheckOk({
      foreignAmountMinor: 1151,
      foreignCurrency: "USD",
      jpyAmountMinorAbs: 1918,
      exchangeRate: 166.6377,
    }),
    true,
  );
  // 66.00 × 168.1516 = 11098.0 → ¥11098 ✓
  assert.equal(
    foreignAmountCrossCheckOk({
      foreignAmountMinor: 6600,
      foreignCurrency: "USD",
      jpyAmountMinorAbs: 11098,
      exchangeRate: 168.1516,
    }),
    true,
  );
  // 3.30 × 167.2728 = 551.99 → ¥552 ✓
  assert.equal(
    foreignAmountCrossCheckOk({
      foreignAmountMinor: 330,
      foreignCurrency: "USD",
      jpyAmountMinorAbs: 552,
      exchangeRate: 167.2728,
    }),
    true,
  );
});

test("foreignAmountCrossCheckOk: mismatch beyond tolerance fails", () => {
  // 11.51 × 166.6377 = 1918, but the JPY total is 5000 → grabbed the wrong row
  assert.equal(
    foreignAmountCrossCheckOk({
      foreignAmountMinor: 1151,
      foreignCurrency: "USD",
      jpyAmountMinorAbs: 5000,
      exchangeRate: 166.6377,
    }),
    false,
  );
});

test("foreignAmountCrossCheckOk: missing rate → pass (soft signal, not a requirement)", () => {
  assert.equal(
    foreignAmountCrossCheckOk({
      foreignAmountMinor: 1151,
      foreignCurrency: "USD",
      jpyAmountMinorAbs: 1918,
      exchangeRate: null,
    }),
    true,
  );
});

// ─── toMinorUnits convention (cents for non-JPY, magnitude for JPY) ──────────

test("toMinorUnits: USD ×100, JPY ×1", () => {
  assert.equal(toMinorUnits(11.51, "USD"), 1151);
  assert.equal(toMinorUnits(66.0, "USD"), 6600);
  assert.equal(toMinorUnits(1234, "JPY"), 1234);
  assert.equal(toMinorUnits(1234, "jpy"), 1234);
});
