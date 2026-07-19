import test from "node:test";
import assert from "node:assert/strict";
import {
  statementMonthToken,
  circledNumber,
  buildEvidenceAssignments,
  buildAmexReconciliationCsv,
  buildPaymentPathReconciliationCsv,
  attendeeIdCells,
  missingReceiptCell,
  AMEX_RECONCILIATION_APPEND_HEADERS,
  PAYMENT_PATH_CSV_HEADERS,
  type EvidenceUnit,
  type AmexLineAppend,
} from "@/lib/receipts/reconciliation-files";
import type { ExportRow } from "@/lib/receipts/types";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";

// ─── statementMonthToken / circledNumber ────────────────────────────────────

test("statementMonthToken: yyyy-mm → MonYYYY (manual-close convention)", () => {
  assert.equal(statementMonthToken("2026-06"), "Jun2026");
  assert.equal(statementMonthToken("2026-03"), "Mar2026");
  assert.equal(statementMonthToken("2027-12"), "Dec2027");
  assert.throws(() => statementMonthToken("2026-13"));
});

test("circledNumber: ①–㊿ ranges + fallback", () => {
  assert.equal(circledNumber(1), "①");
  assert.equal(circledNumber(20), "⑳");
  assert.equal(circledNumber(21), "㉑");
  assert.equal(circledNumber(35), "㉟");
  assert.equal(circledNumber(36), "㊱");
  assert.equal(circledNumber(50), "㊿");
  assert.equal(circledNumber(51), "(51)");
});

// ─── buildEvidenceAssignments ───────────────────────────────────────────────

const unit = (over: Partial<EvidenceUnit>): EvidenceUnit => ({
  receiptId: "r1",
  categoryJa: "会議費",
  merchant: "小田原みなと食堂",
  amountMinor: 6490,
  currency: "JPY",
  ext: "jpg",
  ...over,
});

test("buildEvidenceAssignments: per-category sequence in input order", () => {
  const m = buildEvidenceAssignments("2026-06", [
    unit({ receiptId: "a", categoryJa: "会議費" }),
    unit({ receiptId: "b", categoryJa: "旅費交通費", merchant: "EMot〔鉄道〕", amountMinor: 1900 }),
    unit({ receiptId: "c", categoryJa: "会議費", merchant: "HUB東京オペラシティ店", amountMinor: 7049 }),
  ]);
  assert.equal(m.get("a")!.label, "会議費Jun2026①");
  assert.equal(m.get("b")!.label, "旅費交通費Jun2026①");
  assert.equal(m.get("c")!.label, "会議費Jun2026②");
  assert.equal(m.get("a")!.filename, "会議費Jun2026①小田原みなと食堂¥6,490.jpg");
});

test("buildEvidenceAssignments: shared receipt keeps first assignment", () => {
  const m = buildEvidenceAssignments("2026-06", [
    unit({ receiptId: "shared", categoryJa: "旅費交通費", merchant: "ENEOS", amountMinor: 22770 }),
    unit({ receiptId: "shared", categoryJa: "旅費交通費", merchant: "ENEOS", amountMinor: 22770 }),
    unit({ receiptId: "next", categoryJa: "旅費交通費", merchant: "ENEOS", amountMinor: 3545 }),
  ]);
  assert.equal(m.size, 2);
  assert.equal(m.get("shared")!.label, "旅費交通費Jun2026①");
  assert.equal(m.get("next")!.label, "旅費交通費Jun2026②");
});

test("buildEvidenceAssignments: filename sanitizes merchant, keeps yen commas, pdf ext", () => {
  const m = buildEvidenceAssignments("2026-06", [
    unit({
      receiptId: "x",
      categoryJa: "交際費",
      merchant: "Da808Lounge/Air *VIP",
      amountMinor: 16300,
      ext: "pdf",
    }),
  ]);
  const f = m.get("x")!.filename;
  assert.ok(!f.includes("/"), "forbidden chars stripped");
  assert.ok(!f.includes(" "), "spaces stripped");
  assert.ok(f.endsWith("¥16,300.pdf"), `amount + ext suffix: ${f}`);
  assert.ok(f.startsWith("交際費Jun2026①"), `label prefix: ${f}`);
});

// ─── buildAmexReconciliationCsv (statement passthrough) ─────────────────────

// Minimal Netアンサー-shaped statement: metadata, header, section, charges,
// 小計/合計. Line numbers are 1-based over raw lines.
const STATEMENT = [
  "カード名称,セゾンプラチナビジネス・アメリカンエキスプレスカード",
  "お支払日,2026/06/04",
  "今回ご請求額,376981",
  "利用日,ご利用店名及び商品名,会員区分,支払区分名称,分割区分,金額,備考",
  ",ご利用者名:村上 多寿子 様",
  "2026/04/17,小田原みなと食堂,,1回,,6490,",
  "2026/05/02,ENEOS,,1回,,1,705,",
  ",【小計】,,,,8195,",
  ",【合計】,,,,8195,",
].join("\n");

test("buildAmexReconciliationCsv: frame rows verbatim, header + charge rows appended", () => {
  const appends = new Map<number, AmexLineAppend>([
    [6, {
      kamokuNo: "会議費Jun2026①",
      attendeeIds: "1; 2; 29",
      attendeeCount: "3",
      receiptFileCell: "会議費Jun2026①小田原みなと食堂¥6,490.jpg",
    }],
  ]);
  const out = buildAmexReconciliationCsv(STATEMENT, appends).split("\n");
  // Metadata rows byte-identical.
  assert.equal(out[0], "カード名称,セゾンプラチナビジネス・アメリカンエキスプレスカード");
  assert.equal(out[2], "今回ご請求額,376981");
  // Header row extended with the appended header names.
  assert.equal(
    out[3],
    `利用日,ご利用店名及び商品名,会員区分,支払区分名称,分割区分,金額,備考,${AMEX_RECONCILIATION_APPEND_HEADERS.join(",")}`,
  );
  // Section row verbatim, no appends.
  assert.equal(out[4], ",ご利用者名:村上 多寿子 様");
  // Charge row: original 7 fields + 4 appended cells. Ids always quoted so
  // Excel cannot date-coerce them; the filename cell contains a comma
  // (¥6,490) so csvEscape wraps it.
  assert.equal(
    out[5],
    '2026/04/17,小田原みなと食堂,,1回,,6490,,会議費Jun2026①,"1; 2; 29",3,"会議費Jun2026①小田原みなと食堂¥6,490.jpg"',
  );
  // 小計/合計 rows verbatim.
  assert.equal(out[7], ",【小計】,,,,8195,");
  assert.equal(out[8], ",【合計】,,,,8195,");
});

test("buildAmexReconciliationCsv: comma-split amount rows normalize to 7 fields before appends", () => {
  const appends = new Map<number, AmexLineAppend>([
    [7, {
      kamokuNo: "旅費交通費Jun2026①",
      attendeeIds: "",
      attendeeCount: "",
      receiptFileCell: "旅費交通費Jun2026①ENEOS¥1,705.jpg",
    }],
  ]);
  const out = buildAmexReconciliationCsv(STATEMENT, appends).split("\n");
  // Raw line was "2026/05/02,ENEOS,,1回,,1,705," (8 fields — unquoted comma
  // amount). Normalized: amount rejoined to 1705, memo last.
  const cells = out[6]!.split(",");
  assert.equal(cells[0], "2026/05/02");
  assert.equal(cells[5], "1705");
  // 7 base + 4 appended = 11 cells (ids cell is quoted-empty).
  assert.equal(out[6]!.includes("旅費交通費Jun2026①"), true);
});

test("buildAmexReconciliationCsv: lines without appends and missing-receipt cells", () => {
  const appends = new Map<number, AmexLineAppend>([
    [6, {
      kamokuNo: "通信費",
      attendeeIds: "",
      attendeeCount: "",
      receiptFileCell: missingReceiptCell("Monthly expense"),
    }],
  ]);
  const out = buildAmexReconciliationCsv(STATEMENT, appends).split("\n");
  assert.ok(out[5]!.endsWith("通信費,\"\",,領収書なし：Monthly expense"), out[5]);
  // Charge row 7 got no append entry → passes through verbatim.
  assert.equal(out[6], "2026/05/02,ENEOS,,1回,,1,705,");
});

test("missingReceiptCell: reason optional", () => {
  assert.equal(missingReceiptCell("Monthly expense"), "領収書なし：Monthly expense");
  assert.equal(missingReceiptCell("  "), "領収書なし");
  assert.equal(missingReceiptCell(null), "領収書なし");
});

// ─── attendeeIdCells ────────────────────────────────────────────────────────

const DIRECTORY: ReceiptAttendeeDirectoryEntry[] = [
  { id: 1, name: "村上多寿子", company: "Dazbeez", title: "Manager", created_at: "", updated_at: "" },
  { id: 2, name: "クランデイビット", company: "Dazbeez", title: "CEO", created_at: "", updated_at: "" },
  { id: 29, name: "柴山佳世", company: "X", title: "Y", created_at: "", updated_at: "" },
] as unknown as ReceiptAttendeeDirectoryEntry[];

test("attendeeIdCells: sorted ids joined '; ' (Excel date-coercion guard), count", () => {
  const { ids, count } = attendeeIdCells(
    ["柴山佳世", "村上多寿子", "クランデイビット"],
    DIRECTORY,
  );
  assert.equal(ids, "1; 2; 29");
  assert.equal(count, "3");
});

test("attendeeIdCells: unresolved names render '?', empty list renders blank", () => {
  const { ids, count } = attendeeIdCells(["村上多寿子", "Nobody Known"], DIRECTORY);
  assert.equal(ids, "1; ?");
  assert.equal(count, "2");
  assert.deepEqual(attendeeIdCells([], DIRECTORY), { ids: "", count: "" });
});

// ─── buildPaymentPathReconciliationCsv ──────────────────────────────────────

const receiptRow = (over: Partial<ExportRow>): ExportRow => ({
  rowType: "receipt",
  lineId: null,
  matchStatus: null,
  receiptStatus: null,
  missingReceiptReason: null,
  cardholderName: null,
  businessTripStatus: null,
  receiptId: "r-cash-1",
  status: "reviewed",
  originalR2Key: "receipts/x",
  transactionDate: "2026-06-10",
  merchant: "セブン-イレブン",
  amountMinor: 1200,
  currency: "JPY",
  expenseType: "business",
  expenseCategoryCode: "supplies",
  expenseCategoryJa: "消耗品費",
  expenseCategoryEn: "Supplies and consumables",
  paymentPath: "CASH",
  businessPurpose: null,
  attendees: [],
  invoiceRegistrationNumber: null,
  qualifiedInvoiceStatus: null,
  taxRate: null,
  taxAmountMinor: null,
  sourceType: null,
  counterpartyName: null,
  ...over,
} as ExportRow);

test("buildPaymentPathReconciliationCsv: lean header + attendees + evidence (draft-round feedback)", () => {
  const assignments = buildEvidenceAssignments("2026-06", [
    unit({ receiptId: "r-cash-1", categoryJa: "消耗品費", merchant: "セブン-イレブン", amountMinor: 1200 }),
  ]);
  const csv = buildPaymentPathReconciliationCsv(
    [receiptRow({})],
    new Map(),
    DIRECTORY,
    {},
    assignments,
  );
  const lines = csv.split("\n");
  assert.equal(lines[0], PAYMENT_PATH_CSV_HEADERS.join(","));
  assert.equal(lines[0], "No,利用日,店舗名,金額,科目＆No.,会議-出席者ID,人数,領収書ファイル名");
  assert.ok(lines[1]!.startsWith("1,2026-06-10,セブン-イレブン,1200,"), "No restarts at 1; lean columns");
  assert.ok(lines[1]!.includes("消耗品費Jun2026①"), "科目＆No appended");
  assert.ok(
    lines[1]!.includes("消耗品費Jun2026①セブン-イレブン¥1,200.jpg") ||
      lines[1]!.includes('"消耗品費Jun2026①セブン-イレブン¥1,200.jpg"'),
    "領収書ファイル名 appended",
  );
});

test("buildPaymentPathReconciliationCsv: receipt without assignment gets 領収書なし cell", () => {
  const csv = buildPaymentPathReconciliationCsv(
    [receiptRow({ receiptId: "r-none", missingReceiptReason: null })],
    new Map(),
    DIRECTORY,
    {},
    new Map(),
  );
  assert.ok(csv.split("\n")[1]!.endsWith(",領収書なし"), csv);
});
