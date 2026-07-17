import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAmexNetanswer,
  netanswerLinesToImportInputs,
  isOutsideHomebase,
  detectBusinessTripCandidates,
  DEFAULT_HOMEBASE_SIGNALS,
} from "@/lib/receipts/validation";

// ─── Helper: build ArrayBuffer from a UTF-8 string ────────────────────────────

function toBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

// ─── Minimal valid Netアンサー CSV ─────────────────────────────────────────────

function makeMinimalCsv(transactions: string[] = []): string {
  const header = [
    "カード名称,セゾンプラチナビジネス・アメリカンエキスプレスカード",
    "お支払日,2026/05/07",
    "今回ご請求額,003000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:クランデイビツト ジヨン         様,1,,,,",
  ];
  return [...header, ...transactions].join("\n");
}

// ─── parseAmexNetanswer ────────────────────────────────────────────────────────

test("parseAmexNetanswer: parses metadata rows", () => {
  const csv = makeMinimalCsv([
    "2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,",
    "2026/04/01,スターバックス 新宿店,1,1回,,1485,",
  ]);
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.metadata.cardName, "セゾンプラチナビジネス・アメリカンエキスプレスカード");
  assert.equal(result.metadata.paymentDueDate, "2026-05-07");
  assert.equal(result.metadata.statementTotalCents, 3000);
});

test("parseAmexNetanswer: parses transaction rows", () => {
  const csv = makeMinimalCsv([
    "2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,",
    "2026/04/01,スターバックス 新宿店,1,1回,,1485,",
  ]);
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0]!.merchantName, "HUB 東京オペラシティ店");
  assert.equal(result.lines[0]!.transactionDate, "2026-03-12");
  assert.equal(result.lines[0]!.amountCents, 1515);
  assert.equal(result.lines[0]!.currency, "JPY");
});

test("parseAmexNetanswer: assigns cardholder name from section row", () => {
  const csv = makeMinimalCsv([
    "2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,",
  ]);
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines[0]!.cardholderName, "クランデイビツト ジヨン");
});

test("parseAmexNetanswer: strips 様 suffix from cardholder name", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,0001000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:山田 太郎 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines[0]!.cardholderName, "山田 太郎");
});

test("parseAmexNetanswer: skips subtotal and total rows", () => {
  const csv = makeMinimalCsv([
    "2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,",
    ",【小計】,,,,1515,",
    ",【合計】,,,,1515,",
  ]);
  // Adjust total to match single transaction
  const fixedCsv = csv.replace("003000", "001515");
  const result = parseAmexNetanswer(toBuffer(fixedCsv), "2026-05");
  assert.equal(result.lines.length, 1);
  assert.equal(result.validationErrors.length, 0);
});

test("parseAmexNetanswer: fails when parsed total != statement total", () => {
  const csv = makeMinimalCsv([
    "2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,",
  ]);
  // 1515 != 3000
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.ok(result.validationErrors.length > 0);
  assert.match(result.validationErrors[0]!, /does not match/i);
});

test("parseAmexNetanswer: tracks parsedTotalCents correctly", () => {
  const csv = makeMinimalCsv([
    "2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,",
    "2026/04/01,スターバックス 新宿店,1,1回,,1485,",
  ]);
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.parsedTotalCents, 3000);
});

test("parseAmexNetanswer: error when no header row found", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,0001000",
    "2026/05/01,コンビニ,1,1回,,1000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.ok(result.validationErrors.some((e) => /header/i.test(e)));
});

test("parseAmexNetanswer: handles two cardholder sections", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,0002000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:田中 花子 様,,,,,",
    "2026/05/01,店A,1,1回,,1000,",
    ",【小計】,,,,1000,",
    ",ご利用者名:田中 次郎 様,2,,,,",
    "2026/05/02,店B,2,1回,,1000,",
    ",【小計】,,,,1000,",
    ",【合計】,,,,2000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0]!.cardholderName, "田中 花子");
  assert.equal(result.lines[1]!.cardholderName, "田中 次郎");
  assert.equal(result.validationErrors.length, 0);
});

test("parseAmexNetanswer: returns encoding in metadata", () => {
  const csv = makeMinimalCsv([
    "2026/03/12,テスト,1,1回,,1000,",
    "2026/04/01,テスト2,1,1回,,2000,",
  ]);
  const fixedCsv = csv.replace("003000", "003000"); // total already 3000
  const result = parseAmexNetanswer(toBuffer(fixedCsv), "2026-05");
  assert.equal(result.metadata.encoding, "utf-8");
});

// ─── netanswerLinesToImportInputs ──────────────────────────────────────────────

test("netanswerLinesToImportInputs: maps all fields correctly", () => {
  const csv = makeMinimalCsv([
    "2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,備考テスト",
    "2026/04/01,スターバックス,1,1回,,1485,",
  ]);
  const fixedCsv = csv.replace("003000", "003000");
  const { lines } = parseAmexNetanswer(toBuffer(fixedCsv), "2026-05");
  const inputs = netanswerLinesToImportInputs(lines, "2026-05", "artifact-1", "sha256abc");

  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]!.merchant, "HUB 東京オペラシティ店");
  assert.equal(inputs[0]!.amountMinor, 1515);
  assert.equal(inputs[0]!.statementArtifactId, "artifact-1");
  assert.equal(inputs[0]!.sourceFileSha256, "sha256abc");
  assert.equal(inputs[0]!.cardholderName, "クランデイビツト ジヨン");
  assert.equal(inputs[0]!.rawCsvLineNumber, lines[0]!.lineNumber);
});

// ─── isOutsideHomebase (default signals reproduce former isOutsideTokyo) ────────

test("isOutsideHomebase: homebase (Tokyo) merchants return false", () => {
  assert.equal(isOutsideHomebase("HUB 東京オペラシティ店", DEFAULT_HOMEBASE_SIGNALS), false);
  assert.equal(isOutsideHomebase("スターバックス 渋谷店", DEFAULT_HOMEBASE_SIGNALS), false);
  assert.equal(isOutsideHomebase("新宿レストラン", DEFAULT_HOMEBASE_SIGNALS), false);
  assert.equal(isOutsideHomebase("東京駅近くの店", DEFAULT_HOMEBASE_SIGNALS), false);
});

test("isOutsideHomebase: outside-homebase merchants return true", () => {
  assert.equal(isOutsideHomebase("ピーシーデポ バリューパック -神奈川県 横浜市", DEFAULT_HOMEBASE_SIGNALS), true);
  assert.equal(isOutsideHomebase("JTB KANAGAWANISHI", DEFAULT_HOMEBASE_SIGNALS), true);
  assert.equal(isOutsideHomebase("大阪駅前ホテル", DEFAULT_HOMEBASE_SIGNALS), true);
  assert.equal(isOutsideHomebase("京都レストラン", DEFAULT_HOMEBASE_SIGNALS), true);
});

test("isOutsideHomebase: generic merchants return false", () => {
  assert.equal(isOutsideHomebase("コンビニ", DEFAULT_HOMEBASE_SIGNALS), false);
  assert.equal(isOutsideHomebase("Amazon.com", DEFAULT_HOMEBASE_SIGNALS), false);
});

test("isOutsideHomebase: homebase is configurable (Osaka as homebase → Osaka merchant no longer anchors)", () => {
  // ADR 0010 D3: homebase is a setting, not a hardcoded city.
  assert.equal(isOutsideHomebase("大阪駅前ホテル", [...DEFAULT_HOMEBASE_SIGNALS, "大阪"]), false);
  assert.equal(isOutsideHomebase("京都レストラン", [...DEFAULT_HOMEBASE_SIGNALS, "大阪"]), true);
});

// ─── detectBusinessTripCandidates ─────────────────────────────────────────────

test("detectBusinessTripCandidates: single outside-Tokyo line does not create candidate", () => {
  const lines = [
    {
      id: "line-1",
      cardholderName: "David",
      transactionDate: "2026-03-10",
      merchant: "ピーシーデポ バリューパック -神奈川県 横浜市",
    },
  ];
  const candidates = detectBusinessTripCandidates(lines, DEFAULT_HOMEBASE_SIGNALS);
  assert.equal(candidates.length, 0);
});

test("detectBusinessTripCandidates: two outside-Tokyo lines within window creates one candidate", () => {
  const lines = [
    {
      id: "line-1",
      cardholderName: "David",
      transactionDate: "2026-03-10",
      merchant: "ピーシーデポ -神奈川県 横浜市",
    },
    {
      id: "line-2",
      cardholderName: "David",
      transactionDate: "2026-03-16",
      merchant: "JTB KANAGAWANISHI",
    },
  ];
  const candidates = detectBusinessTripCandidates(lines, DEFAULT_HOMEBASE_SIGNALS);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.cardholderName, "David");
  assert.equal(candidates[0]!.startDate, "2026-03-10");
  assert.equal(candidates[0]!.endDate, "2026-03-16");
  assert.deepEqual(candidates[0]!.lineIds.sort(), ["line-1", "line-2"].sort());
});

test("detectBusinessTripCandidates: lines beyond window are separate candidates", () => {
  const lines = [
    {
      id: "line-1",
      cardholderName: "David",
      transactionDate: "2026-03-01",
      merchant: "大阪ホテル",
    },
    {
      id: "line-2",
      cardholderName: "David",
      transactionDate: "2026-03-02",
      merchant: "京都レストラン",
    },
    {
      id: "line-3",
      cardholderName: "David",
      transactionDate: "2026-03-20",
      merchant: "福岡空港",
    },
    {
      id: "line-4",
      cardholderName: "David",
      transactionDate: "2026-03-21",
      merchant: "札幌ホテル",
    },
  ];
  const candidates = detectBusinessTripCandidates(lines, DEFAULT_HOMEBASE_SIGNALS);
  assert.equal(candidates.length, 2);
});

test("detectBusinessTripCandidates: different cardholders are separate candidates", () => {
  const lines = [
    {
      id: "line-1",
      cardholderName: "Alice",
      transactionDate: "2026-03-10",
      merchant: "大阪ホテル",
    },
    {
      id: "line-2",
      cardholderName: "Alice",
      transactionDate: "2026-03-11",
      merchant: "京都レストラン",
    },
    {
      id: "line-3",
      cardholderName: "Bob",
      transactionDate: "2026-03-10",
      merchant: "大阪ホテル",
    },
    {
      id: "line-4",
      cardholderName: "Bob",
      transactionDate: "2026-03-11",
      merchant: "京都レストラン",
    },
  ];
  const candidates = detectBusinessTripCandidates(lines, DEFAULT_HOMEBASE_SIGNALS);
  assert.equal(candidates.length, 2);
  const cardholders = candidates.map((c) => c.cardholderName).sort();
  assert.deepEqual(cardholders, ["Alice", "Bob"]);
});

test("detectBusinessTripCandidates: Tokyo-only lines do not generate candidates", () => {
  const lines = [
    {
      id: "line-1",
      cardholderName: "David",
      transactionDate: "2026-03-10",
      merchant: "渋谷スターバックス",
    },
    {
      id: "line-2",
      cardholderName: "David",
      transactionDate: "2026-03-11",
      merchant: "新宿レストラン",
    },
  ];
  const candidates = detectBusinessTripCandidates(lines, DEFAULT_HOMEBASE_SIGNALS);
  assert.equal(candidates.length, 0);
});

// ─── CP932 / Shift-JIS encoding ──────────────────────────────────────────────

test("parseAmexNetanswer: decodes CP932/Shift-JIS encoded CSV", () => {
  // Build CSV with Japanese text and encode as Shift-JIS
  const csv = [
    "カード名称,テストカード",
    "お支払日,2026/05/07",
    "今回ご請求額,003000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:山田 太郎 様,,,,,",
    "2026/03/12,東京レストラン,1,1回,,1000,",
    "2026/04/01,大阪ショップ,1,1回,,2000,",
  ].join("\n");

  const buffer = new TextEncoder().encode(csv).buffer as ArrayBuffer;
  const result = parseAmexNetanswer(buffer, "2026-05");

  // Should decode without mojibake (UTF-8 in test env — validates the round-trip)
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0]!.merchantName, "東京レストラン");
  assert.equal(result.lines[1]!.merchantName, "大阪ショップ");
  assert.equal(result.lines[0]!.amountCents, 1000);
});

// ─── Comma-formatted amounts ─────────────────────────────────────────────────

test("parseAmexNetanswer: handles comma thousands separators in amounts", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,0010000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1,000,",
    "2026/05/02,ホテル,1,1回,,9,000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0]!.amountCents, 1000);
  assert.equal(result.lines[1]!.amountCents, 9000);
  assert.equal(result.parsedTotalCents, 10000);
  assert.equal(result.validationErrors.length, 0);
});

test("parseAmexNetanswer: tracks skipped date-rows with missing merchant", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,001000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
    "2026/05/02,,1,1回,,500,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 1);
  assert.equal(result.skippedLines.length, 1);
  assert.match(result.skippedLines[0]!.reason, /missing merchant/);
});

test("parseAmexNetanswer: tracks skipped date-rows with missing amount", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,001000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
    "2026/05/02,スターバックス,1,1回,,,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 1);
  assert.equal(result.skippedLines.length, 1);
  assert.match(result.skippedLines[0]!.reason, /missing amount/);
});

test("parseAmexNetanswer: skippedLines is empty array for clean CSVs", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,001000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.deepEqual(result.skippedLines, []);
});

test("parseAmexNetanswer: refunds (-) keep their sign so totals reconcile", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,000900",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
    "2026/05/02,返金,1,1回,,-100,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0]!.amountCents, 1000);
  assert.equal(result.lines[1]!.amountCents, -100);
  assert.equal(result.parsedTotalCents, 900);
  assert.equal(result.validationErrors.length, 0);
});

test("parseAmexNetanswer: refunds with comma thousands separators keep their sign", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,008800",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,10,000,",
    "2026/05/02,返金,1,1回,,-1,200,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0]!.amountCents, 10000);
  assert.equal(result.lines[1]!.amountCents, -1200);
  assert.equal(result.parsedTotalCents, 8800);
  assert.equal(result.validationErrors.length, 0);
});

test("parseAmexNetanswer: △ (Japanese negative marker) is treated as a refund", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,000900",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
    "2026/05/02,返金,1,1回,,△100,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[1]!.amountCents, -100);
  assert.equal(result.parsedTotalCents, 900);
  assert.equal(result.validationErrors.length, 0);
});

// ─── Undated charge lines (annual fees, etc.) ───────────────────────────────

test("parseAmexNetanswer: imports undated charge lines (e.g. annual fee) instead of dropping them", () => {
  // Regression test for the 2026-07 Saison statement: カード年会費(本会員)
  // has no 利用日 but is a real charge that counts toward 今回ご請求額. The
  // parser previously required col0 to parse as a date, silently dropping
  // this row and breaking the total reconciliation.
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/06",
    "今回ご請求額,0034000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/01,コンビニ,,1回,,1000,",
    ",カード年会費(本会員),,,,33000,",
    ",【小計】,,,,34000,",
    ",【合計】,,,,34000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-07");
  assert.equal(result.lines.length, 2);
  assert.equal(result.parsedTotalCents, 34000);
  assert.equal(result.validationErrors.length, 0);

  const fee = result.lines.find((l) => l.merchantName === "カード年会費(本会員)");
  assert.ok(fee, "annual fee line should be imported, not dropped");
  assert.equal(fee!.amountCents, 33000);
  assert.equal(fee!.noReceiptRequired, true);
  assert.ok(fee!.noReceiptReason);
  // No 利用日 on the statement — falls back to the payment due date so the
  // NOT NULL transaction_date column still gets a sensible value.
  assert.equal(fee!.transactionDate, "2026-07-06");

  const dated = result.lines.find((l) => l.merchantName === "コンビニ");
  assert.equal(dated!.noReceiptRequired, false);
  assert.equal(dated!.noReceiptReason, null);
});

test("parseAmexNetanswer: undated charge line falls back to statement month when payment due date is missing", () => {
  const csv = [
    "カード名称,TestCard",
    "今回ご請求額,0033000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    ",カード年会費(本会員),,,,33000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-07");
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0]!.transactionDate, "2026-07-01");
});

test("netanswerLinesToImportInputs: flags undated charge lines as no_receipt_required", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/06",
    "今回ご請求額,0034000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/01,コンビニ,,1回,,1000,",
    ",カード年会費(本会員),,,,33000,",
  ].join("\n");
  const { lines } = parseAmexNetanswer(toBuffer(csv), "2026-07");
  const inputs = netanswerLinesToImportInputs(lines, "2026-07", "artifact-1", "sha256abc");

  const feeInput = inputs.find((i) => i.merchant === "カード年会費(本会員)");
  assert.equal(feeInput!.receiptStatus, "no_receipt_required");
  assert.ok(feeInput!.receiptMissingReason);

  const datedInput = inputs.find((i) => i.merchant === "コンビニ");
  assert.equal(datedInput!.receiptStatus, undefined);
  assert.equal(datedInput!.receiptMissingReason, undefined);
});

test("parseAmexNetanswer: handles comma thousands separators in metadata total", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,10,000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,10000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.metadata.statementTotalCents, 10000);
  assert.equal(result.validationErrors.length, 0);
});
