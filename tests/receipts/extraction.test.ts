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

// Regression: えきねっと e-ticket receipt. The card's last-4 (5102) shared a
// line with the ¥4,900 total and won the max() pick; the 税込 total line was
// vetoed by the bare-税 skip keyword; and 発行日 (PDF issue date) was extracted
// instead of 購入日 (the card-charge date the AMEX line carries).
test("parseReceiptOcrText: えきねっと ticket — amount is the ¥ total, not card last-4; date is 購入日", () => {
  const parsed = parseReceiptOcrText(`発行日 2026年05月09日12時26分
発行番号 No.E051390017410880429
えきねっと ご利用票兼領収書
下記の金額を、確かに領収しました。
東日本旅客鉄道株式会社
登録番号：T9011001029597
宛名 合同会社Dazbeez
金額
¥4,900(税込10%) クレジットカード利用(カード番号下4桁：5102)
但し きっぷのご購入代金として
予約番号 E05139
購入日 2026年04月25日
乗車日 2026年04月29日`);

  assert.equal(parsed.amountMinor, 4900);
  assert.equal(parsed.transactionDate, "2026-04-25");
  assert.equal(parsed.invoiceRegistrationNumber, "T9011001029597");
  assert.equal(parsed.taxRate, "10%");
});

test("parseReceiptOcrText: masked card numbers and last-4 phrasing never become the amount", () => {
  const parsed = parseReceiptOcrText(`Demo Store
2026/05/16
VISA ****9876
合計 ¥1,200`);

  assert.equal(parsed.amountMinor, 1200);
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
