import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAmexNetanswer,
  netanswerLinesToImportInputs,
  isOutsideTokyo,
  detectBusinessTripCandidates,
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

// ─── isOutsideTokyo ────────────────────────────────────────────────────────────

test("isOutsideTokyo: Tokyo merchants return false", () => {
  assert.equal(isOutsideTokyo("HUB 東京オペラシティ店"), false);
  assert.equal(isOutsideTokyo("スターバックス 渋谷店"), false);
  assert.equal(isOutsideTokyo("新宿レストラン"), false);
  assert.equal(isOutsideTokyo("東京駅近くの店"), false);
});

test("isOutsideTokyo: outside-Tokyo merchants return true", () => {
  assert.equal(isOutsideTokyo("ピーシーデポ バリューパック -神奈川県 横浜市"), true);
  assert.equal(isOutsideTokyo("JTB KANAGAWANISHI"), true);
  assert.equal(isOutsideTokyo("大阪駅前ホテル"), true);
  assert.equal(isOutsideTokyo("京都レストラン"), true);
});

test("isOutsideTokyo: generic merchants return false", () => {
  assert.equal(isOutsideTokyo("コンビニ"), false);
  assert.equal(isOutsideTokyo("Amazon.com"), false);
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
  const candidates = detectBusinessTripCandidates(lines);
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
  const candidates = detectBusinessTripCandidates(lines);
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
  const candidates = detectBusinessTripCandidates(lines);
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
  const candidates = detectBusinessTripCandidates(lines);
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
  const candidates = detectBusinessTripCandidates(lines);
  assert.equal(candidates.length, 0);
});
