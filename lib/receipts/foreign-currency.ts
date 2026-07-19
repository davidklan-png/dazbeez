// Single source of truth for parsing foreign-currency detail out of AMEX
// Netアンサー statement memos. Overseas-billed charges (Cloudflare, Anthropic,
// …) are reported on the statement only as a JPY-converted total; the original
// foreign amount and the FX rate used live in free-text memos:
//   - charge-row memo:        現地通貨額:<amt> <CCY>   e.g. "現地通貨額:11.51 USD"
//   - continuation-row memo:  円換算レート:M/D <rate>   e.g. "円換算レート:6/11 166.6377"
// The continuation row (no date, no amount, merchant text like "(SAN
// FRANCISCO)") is otherwise discarded by the CSV parser as an informational
// row; validation.ts correlates it back onto the preceding foreign charge line.
//
// Both the import path (lib/receipts/validation.ts) and the open-month backfill
// script (scripts/backfill-amex-foreign-currency.ts) call these functions — do
// NOT duplicate the regex or the cross-check elsewhere.

export type ForeignCurrencyParseStatus = "parsed" | "unparsed";

export type ForeignCurrencyParseResult =
  | { status: "none" }
  | { status: "parsed"; amountMinor: number; currency: string }
  | { status: "unparsed" };

// Charge-row marker. Confirmed live against a real 2026-06/07 SAISON statement.
const AMOUNT_MARKER = "現地通貨額";
// Continuation-row marker.
const RATE_MARKER = "円換算レート";

/** Returns the substring after `marker`, or null when the marker is absent. */
function tailAfterMarker(memo: string, marker: string): string | null {
  const idx = memo.indexOf(marker);
  if (idx === -1) return null;
  return memo.slice(idx + marker.length);
}

// Minor-unit convention shared with receipt_records.amount_minor: 0-decimal
// currencies keep their magnitude; everything else is ×100 (cents). Mirrors
// lib/receipts/extraction.ts parseAmountMinor.
const ZERO_DECIMAL_CURRENCIES = new Set([
  "JPY",
  "KRW",
  "VND",
  "IDR",
  "CLP",
  "PYG",
  "UGX",
]);

function minorUnitDivisor(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}

/** Convert a decimal major-unit amount to minor units for a currency code. */
export function toMinorUnits(amountMajor: number, currency: string): number {
  return Math.round(amountMajor * minorUnitDivisor(currency));
}

// Match "<amt> <CCY>" where amt may use comma-thousands grouping and a decimal
// fraction, colon (half- or full-width) may lead, and CCY is a 3-letter ISO
// code. Returns the amount in minor units + uppercase currency, or null when
// both cannot be cleanly extracted.
function parseAmountAndCurrency(
  tail: string,
): { amountMinor: number; currency: string } | null {
  const m = tail.match(
    /^\s*[:：]?\s*(-?\d[\d,]*(?:\.\d{1,4})?)\s+([A-Za-z]{3})\b/,
  );
  if (!m) return null;
  const amount = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount === 0) return null;
  const currency = m[2]!.toUpperCase();
  return { amountMinor: toMinorUnits(Math.abs(amount), currency), currency };
}

/**
 * Parse a charge-row memo for the foreign-currency amount.
 *
 * - No 現地通貨額 marker → `{ status: "none" }` (ordinary domestic-JPY line).
 * - Marker present and amount + 3-letter currency cleanly extracted →
 *   `{ status: "parsed", amountMinor, currency }` (amountMinor is a positive
 *   magnitude in minor units; the caller inherits sign from the line's own
 *   amount_minor so refund lines stay negative).
 * - Marker present but extraction fails → `{ status: "unparsed" }` (surfaces an
 *   amber pill in the reconcile UI — distinct from "no foreign data at all").
 *
 * Confirmed real shapes (used verbatim as test fixtures): "現地通貨額:11.51 USD",
 * "現地通貨額:66.00 USD", "現地通貨額:3.30 USD". Half-width colon, decimal
 * amount, single space, 3-letter code. Full-width "：" and comma-thousands are
 * handled defensively for larger charges.
 */
export function parseForeignCurrencyMemo(
  memo: string | null,
): ForeignCurrencyParseResult {
  if (!memo) return { status: "none" };
  const tail = tailAfterMarker(memo, AMOUNT_MARKER);
  if (tail === null) return { status: "none" };
  const parsed = parseAmountAndCurrency(tail);
  if (!parsed) return { status: "unparsed" };
  return { status: "parsed", ...parsed };
}

/**
 * Parse a continuation-row memo for the FX rate used (円換算レート:M/D <rate>).
 * Returns the rate as a number, or null when the marker is absent or the rate
 * can't be cleanly parsed. This is a SOFT signal only — never authoritative,
 * never used to convert amounts for matching; its sole job is the cross-check
 * below that catches a bad charge-row parse.
 *
 * Confirmed real shapes: "円換算レート:6/11 166.6377", "円換算レート:6/23
 * 168.1516", "円換算レート:7/04 167.2728".
 */
export function parseExchangeRateMemo(memo: string | null): number | null {
  if (!memo) return null;
  const tail = tailAfterMarker(memo, RATE_MARKER);
  if (tail === null) return null;
  const m = tail.match(/[:：]?\s*(?:\d{1,2}\/\d{1,2}\s+)?(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const rate = Number(m[1]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

/**
 * Cross-check a parsed foreign amount against the JPY line total using the FX
 * rate from the continuation row. Returns true (pass) when:
 *   - no rate is available (the rate is a BONUS check, not a requirement — a
 *     cleanly-parsed foreign amount with no rate row stays "parsed"), or
 *   - round(foreignMajor × rate) is within ±1 yen of the JPY line magnitude.
 *
 * A failure (returns false) means the charge-row parse likely grabbed the wrong
 * row or a garbled currency code, and the caller should downgrade
 * memo_currency_parse_status to "unparsed" — matching on a mismatched parse is
 * worse than not matching at all.
 */
export function foreignAmountCrossCheckOk(args: {
  foreignAmountMinor: number;
  foreignCurrency: string;
  /** abs() of the line's JPY amount_minor (the converted statement total). */
  jpyAmountMinorAbs: number;
  exchangeRate: number | null;
}): boolean {
  const { exchangeRate } = args;
  if (exchangeRate == null || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    return true;
  }
  const foreignMajor = Math.abs(args.foreignAmountMinor) / minorUnitDivisor(args.foreignCurrency);
  const expectedJpy = Math.round(foreignMajor * exchangeRate);
  return Math.abs(expectedJpy - args.jpyAmountMinorAbs) <= 1;
}
