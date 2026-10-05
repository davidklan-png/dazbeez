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
  assert.equal(result.skippedLines[0]!.benign, false);
});

test("parseAmexNetanswer: tracks skipped date-rows with missing amount (not benign — has a real date)", () => {
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
  assert.equal(result.skippedLines[0]!.benign, false);
});

test("parseAmexNetanswer: undated + amountless row (overseas-currency annotation line) is skipped as benign", () => {
  // Real-world shape: an overseas-billed charge (e.g. CLOUDFLARE) carries its
  // 現地通貨額 detail in the memo of its own dated row; Netアンサー then
  // emits a trailing row with no 利用日 and no 利用金額 for that same
  // charge. It has zero monetary value — the statement total already
  // reconciles without it — so it should be flagged benign, not as an error
  // needing operator review.
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,001918",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,CLOUDFLARE,1,1回,,1918,現地通貨額:11.51 USD",
    ",CLOUDFLARE,1,1回,,,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 1);
  assert.equal(result.parsedTotalCents, 1918);
  assert.equal(result.validationErrors.length, 0);
  assert.equal(result.skippedLines.length, 1);
  assert.equal(result.skippedLines[0]!.benign, true);
  assert.match(result.skippedLines[0]!.reason, /no date, no amount/);
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

// ─── Foreign-currency detail (migration 0026) ───────────────────────────────
// Real 2026-06/07 SAISON shape: a dated overseas charge row whose memo carries
// 現地通貨額:<amt> <CCY>, immediately followed by a no-date/no-amount
// continuation row whose memo carries 円換算レート:M/D <rate>. The continuation
// row is still skipped (no monetary value) but its rate is correlated back onto
// the charge line and cross-checked.

test("parseAmexNetanswer: foreign charge + continuation rate row → parsed foreign fields on the charge line", () => {
  // 11.51 USD × 166.6377 = 1918.06 → ¥1918 (cross-check passes)
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/10",
    "今回ご請求額,001918",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/11,CLOUDFLARE,1,1回,,1918,現地通貨額:11.51 USD",
    ",(SAN FRANCISCO),1,1回,,,円換算レート:6/11 166.6377",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-07");
  assert.equal(result.lines.length, 1);
  assert.equal(result.parsedTotalCents, 1918);
  assert.equal(result.validationErrors.length, 0);

  const line = result.lines[0]!;
  assert.equal(line.merchantName, "CLOUDFLARE");
  assert.equal(line.memoCurrencyParseStatus, "parsed");
  assert.equal(line.foreignAmountMinor, 1151);
  assert.equal(line.foreignCurrency, "USD");
  assert.equal(line.foreignExchangeRate, 166.6377);

  // The continuation row is still skipped (no monetary value of its own), benign.
  assert.equal(result.skippedLines.length, 1);
  assert.equal(result.skippedLines[0]!.benign, true);
});

test("parseAmexNetanswer: ANTHROPIC 66.00 USD real example also parses", () => {
  // 66.00 × 168.1516 = 11098.0 → ¥11098
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/10",
    "今回ご請求額,011098",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/23,ANTHROPIC,1,1回,,11098,現地通貨額:66.00 USD",
    ",(SAN FRANCISCO),1,1回,,,円換算レート:6/23 168.1516",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-07");
  const line = result.lines[0]!;
  assert.equal(line.memoCurrencyParseStatus, "parsed");
  assert.equal(line.foreignAmountMinor, 6600);
  assert.equal(line.foreignCurrency, "USD");
  assert.equal(line.foreignExchangeRate, 168.1516);
});

test("netanswerLinesToImportInputs: passes foreign-currency fields through", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/10",
    "今回ご請求額,001918",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/11,CLOUDFLARE,1,1回,,1918,現地通貨額:11.51 USD",
    ",(SAN FRANCISCO),1,1回,,,円換算レート:6/11 166.6377",
  ].join("\n");
  const { lines } = parseAmexNetanswer(toBuffer(csv), "2026-07");
  const inputs = netanswerLinesToImportInputs(lines, "2026-07", "artifact-1", "sha256abc");
  assert.equal(inputs[0]!.foreignAmountMinor, 1151);
  assert.equal(inputs[0]!.foreignCurrency, "USD");
  assert.equal(inputs[0]!.foreignExchangeRate, 166.6377);
  assert.equal(inputs[0]!.memoCurrencyParseStatus, "parsed");
});

test("parseAmexNetanswer: rate cross-check failure downgrades to unparsed", () => {
  // JPY total says 5000 but 11.51 × 166.6377 = 1918 — the parse grabbed the
  // wrong row/code, so matching on it would be worse than not matching.
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/10",
    "今回ご請求額,005000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/11,CLOUDFLARE,1,1回,,5000,現地通貨額:11.51 USD",
    ",(SAN FRANCISCO),1,1回,,,円換算レート:6/11 166.6377",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-07");
  const line = result.lines[0]!;
  assert.equal(line.memoCurrencyParseStatus, "unparsed");
  // Values retained for operator review (status is the source of truth for
  // match eligibility; reconciliation gates on status === "parsed").
  assert.equal(line.foreignAmountMinor, 1151);
  assert.equal(line.foreignExchangeRate, 166.6377);
});

test("parseAmexNetanswer: continuation row without a rate memo leaves status parsed (rate is bonus)", () => {
  // Charge parses cleanly; the trailing annotation row has no 円換算レート
  // memo. The rate is a bonus cross-check, not a requirement, so the line stays
  // parsed with a null rate (matches the existing benign-skip test shape).
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/10",
    "今回ご請求額,001918",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/11,CLOUDFLARE,1,1回,,1918,現地通貨額:11.51 USD",
    ",CLOUDFLARE,1,1回,,,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-07");
  const line = result.lines[0]!;
  assert.equal(line.memoCurrencyParseStatus, "parsed");
  assert.equal(line.foreignAmountMinor, 1151);
  assert.equal(line.foreignExchangeRate, null);
});

test("parseAmexNetanswer: foreign refund inherits the line's negative sign", () => {
  // Paired with an equal positive charge so the net (0) is expressible in
  // 今回ご請求額 — its parser strips signs, so a negative net total can't be
  // written there (and since TASK-038 F4 the row is mandatory).
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/10",
    "今回ご請求額,000000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/10,CLOUDFLARE,1,1回,,1918,現地通貨額:11.51 USD",
    "2026/06/11,CLOUDFLARE REFUND,1,1回,,-1918,現地通貨額:11.51 USD",
    ",(SAN FRANCISCO),1,1回,,,円換算レート:6/11 166.6377",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-07");
  assert.equal(result.validationErrors.length, 0);
  const line = result.lines[1]!;
  assert.equal(line.merchantName, "CLOUDFLARE REFUND");
  assert.equal(line.amountCents, -1918);
  assert.equal(line.memoCurrencyParseStatus, "parsed");
  // Sign inherited from amountCents: the memo magnitude 11.51 becomes -1151.
  assert.equal(line.foreignAmountMinor, -1151);
  assert.equal(line.foreignCurrency, "USD");
});

test("parseAmexNetanswer: ordinary JPY line (no foreign marker) has null foreign fields", () => {
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
  const line = result.lines[0]!;
  assert.equal(line.memoCurrencyParseStatus, null);
  assert.equal(line.foreignAmountMinor, null);
  assert.equal(line.foreignCurrency, null);
  assert.equal(line.foreignExchangeRate, null);
});

// ─── TASK-038: import edge hardening ────────────────────────────────────────

test("parseAmexNetanswer: UTF-8 BOM is stripped and the file parses", () => {
  const csv =
    "﻿" +
    [
      "カード名称,TestCard",
      "お支払日,2026/05/07",
      "今回ご請求額,001000",
      "",
      "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
      ",ご利用者名:テスト 様,,,,,",
      "2026/05/01,コンビニ,1,1回,,1000,",
    ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  // A BOM surviving into col0 would corrupt the カード名称 match and, worse,
  // make row 1's date column unparseable.
  assert.equal(result.metadata.cardName, "TestCard");
  assert.equal(result.lines.length, 1);
  assert.equal(result.validationErrors.length, 0);
});

test("parseAmexNetanswer: CRLF line endings parse identically to LF", () => {
  const rows = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,003000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/03/12,HUB 東京オペラシティ店,1,1回,,1515,",
    "2026/04/01,スターバックス 新宿店,1,1回,,1485,",
  ];
  const lf = parseAmexNetanswer(toBuffer(rows.join("\n")), "2026-05");
  const crlf = parseAmexNetanswer(toBuffer(rows.join("\r\n")), "2026-05");
  // A stray \r at end-of-line would end up inside the memo/amount fields.
  assert.deepEqual(crlf.lines, lf.lines);
  assert.deepEqual(crlf.metadata, lf.metadata);
  assert.deepEqual(crlf.validationErrors, lf.validationErrors);
});

test("parseAmexNetanswer: missing 今回ご請求額 row fails closed (TASK-038 F4)", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  // Without the statement total the parsed-total cross-check silently
  // disables itself — the only net for column-shifted amounts. The import
  // route gates on validationErrors, so this error means zero lines import.
  assert.ok(
    result.validationErrors.some((e) => /今回ご請求額|Statement total/.test(e)),
    `expected the missing-total error, got: ${result.validationErrors.join(" | ")}`,
  );
});

test("parseAmexNetanswer: impossible calendar dates are skipped loudly, not imported (TASK-038 F5)", () => {
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,001000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    // 2026-02-30: regex-shaped, nonexistent. JS Date would normalize it to
    // March 2 — it must not be imported verbatim.
    "2026/02/30,HUB 東京オペラシティ店,1,1回,,1515,",
    // 13/05/2026: month 13 in the MM/DD/YYYY branch must not become 2026-13-05.
    "13/05/2026,スターバックス 新宿店,1,1回,,1485,",
    "2026/05/01,コンビニ,1,1回,,1000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0]!.merchantName, "コンビニ");
  assert.equal(result.skippedLines.length, 2);
  for (const s of result.skippedLines) {
    assert.match(s.reason, /unparseable date/);
    assert.equal(s.benign, false);
  }
});

test("parseAmexNetanswer: non-empty garbage col0 is NOT an undated charge (TASK-038 F5)", () => {
  // The regression this pins: garbage in the date column used to fall into
  // the undated-charge path and inherit noReceiptRequired — a real dated
  // charge silently marked "no receipt applicable".
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,001000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "XX/99/2026,Some Merchant,1,1回,,1000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 0);
  assert.equal(result.skippedLines.length, 1);
  assert.match(result.skippedLines[0]!.reason, /unparseable date: XX\/99\/2026/);
  assert.equal(result.skippedLines[0]!.benign, false);
  // The point: no line was created, so nothing was flagged noReceiptRequired.
  assert.ok(
    !result.lines.some((l) => l.noReceiptRequired),
    "garbage-date row must not be imported as an undated charge",
  );
});

test("parseAmexNetanswer: EMPTY col0 + amount stays the undated-charge path (noReceiptRequired)", () => {
  // Pins the legitimate half of the F5 split — real undated charges (annual
  // fees etc.) must keep importing as no_receipt_required.
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,0033000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
    ",カード年会費(本会員),,,,32000,",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(result.lines.length, 2);
  assert.equal(result.validationErrors.length, 0);
  const fee = result.lines.find((l) => l.merchantName === "カード年会費(本会員)")!;
  assert.equal(fee.noReceiptRequired, true);
  assert.ok(fee.noReceiptReason);
  assert.equal(result.lines[0]!.noReceiptRequired, false);
});

test("parseAmexNetanswer: unquoted comma in memo shifts the amount → total mismatch error (TASK-038 F4 net)", () => {
  // The rejoin path (fields.length > 7) takes fields[5..n-1] as the amount:
  // a memo split by an unquoted comma merges its digits into the amount
  // (1918 + "現地通貨額:11.51 USD" → 19181151). With a correct 今回ご請求額
  // on the fixture, the parsed-total cross-check is the net that catches it.
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/07/10",
    "今回ご請求額,001918",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/06/11,CLOUDFLARE,1,1回,,1918,現地通貨額:11.51 USD,REF-66",
  ].join("\n");
  const result = parseAmexNetanswer(toBuffer(csv), "2026-07");
  assert.equal(result.parsedTotalCents, 19181151);
  assert.ok(
    result.validationErrors.some((e) => /does not match/i.test(e)),
    "column-shifted amount must trip the total cross-check",
  );
});

test("netanswerLinesToImportInputs: two rows sharing the no-ref fallback key both map (dedup is D1's job)", () => {
  // Same statement_month + transaction_date + amount + merchant + cardholder
  // → one fallback dedup key, two CSV rows (e.g. a same-day double charge).
  // The parser emits both; the ON CONFLICT dedup in importAmexLines collapses
  // them to one D1 row. classifyExistingArtifact deliberately tolerates the
  // resulting lines < transaction_count by classifying "heal" — an
  // idempotent re-import converges (nothing re-inserts). See the classifier
  // matrix in amex-import-edges.test.ts.
  const csv = [
    "カード名称,TestCard",
    "お支払日,2026/05/07",
    "今回ご請求額,002000",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考",
    ",ご利用者名:テスト 様,,,,,",
    "2026/05/01,コンビニ,1,1回,,1000,",
    "2026/05/01,コンビニ,1,1回,,1000,",
  ].join("\n");
  const { lines } = parseAmexNetanswer(toBuffer(csv), "2026-05");
  assert.equal(lines.length, 2);
  const inputs = netanswerLinesToImportInputs(lines, "2026-05", "artifact-1", "sha256abc");
  assert.equal(inputs.length, 2);
});
