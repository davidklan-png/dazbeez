// TASK-041 — cross-month review search: parseReviewSearch +
// buildReviewSearchSql (lib/receipts/review-search.ts) and the `q` threading
// through review-queue-filter's URL builders. Pure unit tests — no D1.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewSearchSql,
  parseReviewSearch,
} from "@/lib/receipts/review-search";
import {
  buildReviewControlQuery,
  buildReviewQueryParams,
  normalizeReviewSearch,
} from "@/lib/receipts/review-queue-filter";

// ─── parseReviewSearch ──────────────────────────────────────────────────────

test("parseReviewSearch: empty / whitespace-only input → null", () => {
  assert.equal(parseReviewSearch(""), null);
  assert.equal(parseReviewSearch("   "), null);
  assert.equal(parseReviewSearch("\t\n"), null);
});

test("parseReviewSearch: amount forms all normalize to the same minor units", () => {
  for (const raw of ["1061", "1,061", "¥1,061", "1061円", "¥1,061円"]) {
    assert.deepEqual(parseReviewSearch(raw), {
      terms: [],
      amountMinor: 1061,
      date: null,
    });
  }
});

test("parseReviewSearch: YYYY-MM-DD token → exact date, no terms", () => {
  assert.deepEqual(parseReviewSearch("2026-10-15"), {
    terms: [],
    amountMinor: null,
    date: "2026-10-15",
  });
});

test("parseReviewSearch: mixed tokens split into term + amount + date", () => {
  assert.deepEqual(parseReviewSearch("ヤマト運輸 ¥1,061 2026-10-15"), {
    terms: ["ヤマト運輸"],
    amountMinor: 1061,
    date: "2026-10-15",
  });
});

test("parseReviewSearch: multiple text terms casefolded and kept in order", () => {
  assert.deepEqual(parseReviewSearch("StarBucks invoice.PDF"), {
    terms: ["starbucks", "invoice.pdf"],
    amountMinor: null,
    date: null,
  });
});

test("parseReviewSearch: a second date/amount token falls through to terms", () => {
  const parsed = parseReviewSearch("2026-10-15 2026-10-16 500 600");
  assert.ok(parsed);
  assert.equal(parsed.date, "2026-10-15");
  assert.equal(parsed.amountMinor, 500);
  assert.deepEqual(parsed.terms, ["2026-10-16", "600"]);
});

test("parseReviewSearch: %-shaped tokens are still terms (escaped at SQL time)", () => {
  assert.deepEqual(parseReviewSearch("100%"), {
    terms: ["100%"],
    amountMinor: null,
    date: null,
  });
});

// ─── buildReviewSearchSql ───────────────────────────────────────────────────

test("buildReviewSearchSql: bare search hits no predicate besides deleted_at", () => {
  const { where, params } = buildReviewSearchSql({
    terms: [],
    amountMinor: null,
    date: null,
  });
  assert.equal(where, "deleted_at IS NULL");
  assert.deepEqual(params, []);
});

test("buildReviewSearchSql: term → merchant OR filename LIKE, with ESCAPE", () => {
  const { where, params } = buildReviewSearchSql({
    terms: ["ヤマト"],
    amountMinor: null,
    date: null,
  });
  assert.equal(
    where,
    "deleted_at IS NULL AND (LOWER(merchant) LIKE ? ESCAPE '\\' OR LOWER(original_filename) LIKE ? ESCAPE '\\')",
  );
  assert.deepEqual(params, ["%ヤマト%", "%ヤマト%"]);
});

test("buildReviewSearchSql: amount + date become equality predicates after the terms", () => {
  const { where, params } = buildReviewSearchSql({
    terms: ["starbucks"],
    amountMinor: 1061,
    date: "2026-10-15",
  });
  assert.ok(where.startsWith("deleted_at IS NULL AND (LOWER(merchant)"));
  assert.ok(where.endsWith("AND amount_minor = ? AND transaction_date = ?"));
  assert.deepEqual(params, [
    "%starbucks%",
    "%starbucks%",
    1061,
    "2026-10-15",
  ]);
});

test("buildReviewSearchSql: LIKE wildcards in terms are escaped literally", () => {
  const { params } = buildReviewSearchSql({
    terms: ["100%", "a_b", "c\\d"],
    amountMinor: null,
    date: null,
  });
  assert.deepEqual(params, [
    "%100\\%%",
    "%100\\%%",
    "%a\\_b%",
    "%a\\_b%",
    "%c\\\\d%",
    "%c\\\\d%",
  ]);
});

test("buildReviewSearchSql: multiple terms AND together", () => {
  const { where } = buildReviewSearchSql({
    terms: ["aa", "bb"],
    amountMinor: null,
    date: null,
  });
  assert.equal(
    where.match(/LOWER\(merchant\) LIKE/g)?.length,
    2,
    "one OR-pair per term",
  );
  assert.ok(where.includes(") AND (LOWER(merchant)"));
});

// ─── q threading through the URL builders ───────────────────────────────────

test("normalizeReviewSearch: trims, caps at 100 chars, absent/array → ''", () => {
  assert.equal(normalizeReviewSearch(undefined), "");
  assert.equal(normalizeReviewSearch(["x"] as unknown as string), "");
  assert.equal(normalizeReviewSearch("  ヤマト  "), "ヤマト");
  assert.equal(normalizeReviewSearch("x".repeat(150)).length, 100);
});

test("buildReviewQueryParams: q survives j/k rail navigation round-trip", () => {
  const qs = buildReviewQueryParams(
    { q: "ヤマト", filter: "amex" },
    "2026-10",
  );
  // Decode rather than assert the exact percent-encoding.
  const sp = new URLSearchParams(qs.replace(/^\?/, ""));
  assert.equal(sp.get("q"), "ヤマト");
  assert.equal(sp.get("filter"), "amex");
  assert.equal(sp.get("month"), "2026-10");
});

test("buildReviewQueryParams: empty/whitespace q is dropped, not carried", () => {
  const qs = buildReviewQueryParams({ q: "   ", filter: "needs" }, "");
  assert.equal(qs, "?filter=needs");
});

test("buildReviewControlQuery: filter-tab hrefs keep the active search", () => {
  const qs = buildReviewControlQuery({
    month: "2026-10",
    filter: "needs",
    scope: "calendar",
    q: "¥1,061",
  });
  const sp = new URLSearchParams(qs.replace(/^\?/, ""));
  assert.equal(sp.get("q"), "¥1,061");
  assert.equal(sp.get("filter"), "needs");
});

test("buildReviewControlQuery: clearing the search (no q) drops the param", () => {
  const qs = buildReviewControlQuery({
    month: "2026-10",
    filter: null,
    scope: "calendar",
  });
  assert.equal(qs, "?month=2026-10");
});
