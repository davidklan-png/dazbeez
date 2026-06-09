import assert from "node:assert/strict";
import test from "node:test";
import { parseReceiptOcrText } from "@/lib/receipts/extraction";

// Real OCR rawText pulled from production receipts that the previous parser
// mis-read (it returned the first non-trivial line — usually a card brand,
// receipt label, cardholder, or capture noise). These fixtures lock in the fix.

const HOLIDAY = `け
H
(7
り
[3
ろ
Nz
も
H
あいう
command
fn
領収書
様
担当
印
領収金額
¥10,680- (内消費税等 ¥971-)
10%
税率対象商品 ¥10,680
内消費税 ¥971
8%
税率対象商品 ¥0
内消費税 ¥0
非課税対象商品 ¥0
但し、飲食代
として上記金額を領収いたしました。
番号:M17807354479999329
HOLIDAY SKY LOUNGE 新宿
TEL:08065580706
登録番号: 19011101088436
2026-06-06 17:44:07
東京都新宿区大久保1-8-4 SQUARE 屋上
camer
www`;

const GOHAN = `ごはん献
丸屋さ
0004-0001
会計日: 2026/6/3
領収書
様
¥8,300-
領収金額
(内消費税等
¥754)
上記正に領収いたしました
但ご飲食代として
和ごはん一献 丸
CEO
東京都中野区
東中野4-23-1
TEL: 03-3361-2875
登録番号: T2810074043972
担当者:若林 洋輔`;

const JIN = `領収証
★
19600)
AM6X
接待費 May (3)
様
但御飲食代として
2026年4月6日
登録番号:T8810360941032
9600
〒169-0074 東京都新宿区北新宿4-16-4-1F
居酒屋 じん
TEL03(3367) 2972`;

const SALAD = `AMEX
0004-0017
会計日:2026/3/24
領収書ay 7
様
領収金額
¥3,782-
上記正に領収いたしました
サラダデリマル
ゴ西新宿五丁目
本店
東京都渋谷区本町3-9-3
TEL : 03-5302-1808
登録番号: T7060001024093`;

const HUB = `2026 年 3 月 12 日(木)
DAVID 様
領収 証
AMGX
¥6,824-
会費
ご飲食代金等と致しまして(消費税込み)
T8010001087103
東京都新宿区西新宿3-20-2
東京オペラシティビルB1F
HUB東京オペラシティ店
電話 03-5353-6364
担当者 桐生`;

const TULLYS = `AMEX TULLY'S
COFFFF
リスト
タリーズコーヒー
たまプラーザテラス
リンクプラザ
TEL : 045-910-1017
登録番号: T9011101048118
2016年03月09日 (月) 16時42分44秒
小計
¥885`;

const GARBAGE = /^(amex|amgx|am6x|amex tully's|領収証|領収書|david|david 様|\(7)$/i;

test("merchant: HOLIDAY — store name resolved past capture noise + label", () => {
  const r = parseReceiptOcrText(HOLIDAY);
  assert.equal(r.merchant, "HOLIDAY SKY LOUNGE 新宿");
  assert.equal(r.amountMinor, 10680);
  assert.equal(r.transactionDate, "2026-06-06");
  // tax amount + rate enhancement
  assert.equal(r.taxAmountMinor, 971);
  assert.equal(r.taxRate, "10%");
  // 14-digit number without the "T" prefix is NOT a valid qualified-invoice no.
  assert.equal(r.invoiceRegistrationNumber, null);
});

test("invoice number: T + 13 digits extracted and normalized", () => {
  assert.equal(parseReceiptOcrText(GOHAN).invoiceRegistrationNumber, "T2810074043972");
  assert.equal(parseReceiptOcrText(JIN).invoiceRegistrationNumber, "T8810360941032");
  assert.equal(parseReceiptOcrText(HUB).invoiceRegistrationNumber, "T8010001087103");
  assert.equal(parseReceiptOcrText(TULLYS).invoiceRegistrationNumber, "T9011101048118");
});

test("merchant: card brands / labels / cardholder are never returned", () => {
  for (const [name, raw] of Object.entries({ HOLIDAY, GOHAN, JIN, SALAD, HUB, TULLYS })) {
    const m = parseReceiptOcrText(raw).merchant;
    assert.ok(m && m.length >= 2, `${name}: merchant should be populated`);
    assert.ok(!GARBAGE.test(m.trim()), `${name}: merchant "${m}" is garbage`);
    assert.ok(!/^amex\b/i.test(m), `${name}: merchant "${m}" still has card prefix`);
  }
});

test("merchant: anchors on real store name for JIN and HUB", () => {
  assert.equal(parseReceiptOcrText(JIN).merchant, "居酒屋 じん");
  assert.ok(/HUB/.test(parseReceiptOcrText(HUB).merchant ?? ""));
});

test("expense type is still NOT inferred from OCR (compliance contract)", () => {
  assert.equal(parseReceiptOcrText(HOLIDAY).expenseType, null);
  assert.equal(parseReceiptOcrText(JIN).expenseType, null);
});
