import assert from "node:assert/strict";
import test from "node:test";
import { parseReceiptOcrText } from "@/lib/receipts/extraction";

test("parseReceiptOcrText: extracts Japanese receipt basics", () => {
  const parsed = parseReceiptOcrText(`株式会社テストストア
領収書
2026年5月16日
小計 ¥1,364
消費税 ¥136
合計 ¥1,500`);

  assert.equal(parsed.transactionDate, "2026-05-16");
  assert.equal(parsed.merchant, "株式会社テストストア");
  assert.equal(parsed.amountMinor, 1500);
  assert.equal(parsed.currency, "JPY");
});

test("parseReceiptOcrText: extracts Reiwa dates", () => {
  const parsed = parseReceiptOcrText(`カフェ蜂
令和6年01月05日
合計 2,750円`);

  assert.equal(parsed.transactionDate, "2024-01-05");
  assert.equal(parsed.merchant, "カフェ蜂");
  assert.equal(parsed.amountMinor, 2750);
});

test("parseReceiptOcrText: does not invent category or attendees from OCR text", () => {
  const parsed = parseReceiptOcrText(`Demo Restaurant
2026/05/16
Total 42.50 USD`);

  assert.equal(parsed.expenseType, null);
  assert.equal(parsed.expenseCategoryCode, null);
  assert.equal(parsed.businessPurpose, null);
  assert.equal(parsed.amountMinor, 4250);
  assert.equal(parsed.currency, "USD");
  assert.deepEqual(parsed.attendeeNames, []);
});
