import test from "node:test";
import assert from "node:assert/strict";
import {
  compactUndefinedReceiptUpdate,
  parseExportStatementMonthOverride,
} from "@/lib/receipts/receipt-update";
import { buildReceiptUpdateSets } from "@/lib/receipts/db";
import type { ReceiptRecord, UpdateReceiptInput } from "@/lib/receipts/types";

// buildReceiptUpdateSets only reads before.extraction_state; a minimal fixture
// (state not pending) keeps the ADR-0001 guard from firing.
const before = { extraction_state: "processed" } as unknown as ReceiptRecord;
const U = (x: Partial<UpdateReceiptInput>): UpdateReceiptInput =>
  x as UpdateReceiptInput;

// ─── compactUndefinedReceiptUpdate (root-cause fix) ──────────────────────────

test("compactUndefinedReceiptUpdate: drops undefined own properties", () => {
  const out = compactUndefinedReceiptUpdate({ a: 1, b: undefined, c: "x" }) as Record<
    string,
    unknown
  >;
  assert.deepEqual(out, { a: 1, c: "x" });
  assert.ok(!("b" in out), "undefined-valued own property must be dropped");
});

test("compactUndefinedReceiptUpdate: preserves explicit null + falsy-defined values", () => {
  const out = compactUndefinedReceiptUpdate({
    a: null,
    b: undefined,
    c: 0,
    d: "",
  }) as Record<string, unknown>;
  assert.equal(out["a"], null, "explicit null preserved (legitimate clear)");
  assert.ok(!("b" in out), "undefined dropped");
  assert.equal(out["c"], 0, "falsy-but-defined preserved");
  assert.equal(out["d"], "", "empty string preserved");
});

test("compactUndefinedReceiptUpdate: omitted exportStatementMonth (undefined) is dropped — does not clear membership", () => {
  const out = compactUndefinedReceiptUpdate({
    merchant: "X",
    exportStatementMonth: undefined,
  }) as Record<string, unknown>;
  assert.ok(!("exportStatementMonth" in out));
  assert.equal(out["merchant"], "X");
});

// ─── parseExportStatementMonthOverride ───────────────────────────────────────

test("parseExportStatementMonthOverride: null/empty → empty (rejected; sticky authority)", () => {
  assert.equal(parseExportStatementMonthOverride(null).kind, "empty");
  assert.equal(parseExportStatementMonthOverride("").kind, "empty");
});

test("parseExportStatementMonthOverride: invalid → invalid", () => {
  assert.equal(parseExportStatementMonthOverride("2026").kind, "invalid");
  assert.equal(parseExportStatementMonthOverride("june").kind, "invalid");
  assert.equal(parseExportStatementMonthOverride(7).kind, "invalid");
});

test("parseExportStatementMonthOverride: concrete YYYY-MM → month (valid explicit override)", () => {
  const r = parseExportStatementMonthOverride("2026-07");
  assert.equal(r.kind, "month");
  assert.equal(r.kind === "month" ? r.value : null, "2026-07");
});

// ─── buildReceiptUpdateSets (sparse / undefined-aware presence) ───────────────

test("buildReceiptUpdateSets: empty / attendees-only input → no sets (no UPDATE, no audit)", () => {
  const { sets } = buildReceiptUpdateSets(U({}), before);
  assert.equal(sets.length, 0, "an attendees-only PATCH must not produce any SET clauses");
});

test("buildReceiptUpdateSets: merchant-only PATCH sets only merchant — not date/category/membership/extraction", () => {
  const { sets } = buildReceiptUpdateSets(U({ merchant: "X" }), before);
  assert.ok(sets.some((s) => s.startsWith("merchant")), "merchant should be set");
  for (const col of [
    "transaction_date",
    "expense_category_code",
    "export_statement_month",
    "extraction_json",
    "business_purpose",
    "amount_minor",
  ]) {
    assert.ok(
      !sets.some((s) => s.startsWith(col)),
      `${col} must not be touched by a merchant-only PATCH`,
    );
  }
});

test("buildReceiptUpdateSets: status-only PATCH sets only status", () => {
  const { sets } = buildReceiptUpdateSets(U({ status: "reviewed" }), before);
  assert.ok(sets.some((s) => s.startsWith("status")));
  assert.ok(!sets.some((s) => s.startsWith("transaction_date")));
  assert.ok(!sets.some((s) => s.startsWith("expense_category_code")));
  assert.ok(!sets.some((s) => s.startsWith("export_statement_month")));
});

test("buildReceiptUpdateSets: undefined exportStatementMonth does NOT bind (no silent NULL clear)", () => {
  const { sets } = buildReceiptUpdateSets(
    U({ merchant: "X", exportStatementMonth: undefined }),
    before,
  );
  assert.ok(
    !sets.some((s) => s.startsWith("export_statement_month")),
    "undefined exportStatementMonth must not bind",
  );
});

test("buildReceiptUpdateSets: explicit null exportStatementMonth IS bound (mechanism honored)", () => {
  // The route now rejects null overrides, but the column mechanism still honors
  // explicit null — guard the mechanism (used for legitimately clearable fields).
  const { sets, binds } = buildReceiptUpdateSets(U({ exportStatementMonth: null }), before);
  const idx = sets.findIndex((s) => s.startsWith("export_statement_month"));
  assert.ok(idx >= 0, "explicit null should bind export_statement_month");
  assert.equal(binds[idx], null);
});

test("buildReceiptUpdateSets: explicit null businessPurpose binds NULL (clearing a clearable field)", () => {
  const { sets, binds } = buildReceiptUpdateSets(U({ businessPurpose: null }), before);
  const idx = sets.findIndex((s) => s.startsWith("business_purpose"));
  assert.ok(idx >= 0);
  assert.equal(binds[idx], null);
});
