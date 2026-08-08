import test from "node:test";
import assert from "node:assert/strict";
import { assembleProofsZip, type ProofZipEntry } from "@/lib/receipts/proofs";
import { buildPackNames } from "@/lib/receipts/pack-naming";
import { runPreflightOnSealedZip } from "@/lib/receipts/delivery-preflight";

const enc = new TextEncoder();
const names = buildPackNames("2026-06", "2026-06-04");
const BOM = String.fromCharCode(0xfeff); // explicit U+FEFF — the pack CSVs ship UTF-8-BOM

// A realistic Netアンサー AMEX 照合CSV: metadata before the 利用日 header, totals
// after the charges, UTF-8-BOM (as the real route ships it). Exercises both the
// P2 #2 charge-row parsing AND the BOM strip.
const AMEX_REALISTIC =
  BOM +
  [
    "カード名称,セゾンプラチナビジネス・アメリカンエキスプレス・カード",
    "ご利用者名,DAVID KLAN",
    "お支払日,2026/07/06",
    "利用日,ご利用店名及び商品名,会員区分,支払区分名称,分割区分,金額,備考,科目＆No.,事業目的,人数,領収書ファイル名",
    '2026/04/17,小田原みなと食堂,,1回,,6490,,会議費Jun2026①,打ち合わせ,1,"会議費Jun2026①小田原みなと食堂￥6,490.jpg"',
    '2026/05/02,OpenAI,,1回,,108341,,研究開発費Jun2026①,API,1,"研究開発費Jun2026①OpenAI￥108,341.pdf"',
    "小計,,,,,114831",
    "合計,,,,,114831",
  ].join("\r\n");

const SUMMARY =
  BOM +
  [
    "Field,Value", "Month,2026-06", "GeneratedAt,t", "",
    "勘定科目,件数,合計金額", "会議費,1,6490", "研究開発費,1,108341", "",
    "支払方法,件数,合計金額", "AMEX,2,114831", "現金,0,0", "デジタル,0,0", "",
    "総合計,2,114831",
  ].join("\r\n");

function evidenceEntry(over: Partial<ProofZipEntry>): ProofZipEntry {
  return {
    no: 1,
    categoryJa: "会議費",
    merchant: "小田原みなと食堂",
    amountMinor: 6490,
    currency: "JPY",
    ext: "jpg",
    bytes: enc.encode("img"),
    transactionDate: "2026-04-17",
    attendees: "",
    paymentPath: "AMEX",
    filename: "会議費Jun2026①小田原みなと食堂￥6,490.jpg",
    ...over,
  };
}

const entries = [
  evidenceEntry({ no: 1, filename: "会議費Jun2026①小田原みなと食堂￥6,490.jpg" }),
  evidenceEntry({
    no: 2,
    categoryJa: "研究開発費",
    merchant: "OpenAI",
    amountMinor: 108341,
    ext: "pdf",
    transactionDate: "2026-05-02",
    filename: "研究開発費Jun2026①OpenAI￥108,341.pdf",
  }),
];

const noticeInput = {
  monthLabel: "2026年6月",
  rowCount: 2,
  receiptCount: 2,
  missingReceiptLines: [],
  hasAmex: true,
  hasCash: false,
  hasDigital: false,
};

function buildPack(amex = AMEX_REALISTIC, summary = SUMMARY): Uint8Array {
  return assembleProofsZip(names, entries, noticeInput, summary, {
    amex,
    cash: null,
    digital: null,
  });
}

test("runPreflightOnSealedZip: a real built pack (BOM, metadata, totals) passes the gate", async () => {
  const report = await runPreflightOnSealedZip({
    zipBytes: buildPack(),
    month: "2026-06",
    paymentDueDate: "2026-06-04",
    maxPackBytes: 100_000_000,
  });
  const failed = report.results.filter((r) => !r.passed);
  assert.equal(report.passed, true, `unexpected failures: ${JSON.stringify(failed)}`);
});

test("runPreflightOnSealedZip: a pack whose 集計 total drifts from the AMEX charges fails", async () => {
  // The AMEX charges sum to 114831; lie in 集計 → summary-payment-path-reconciles fails.
  const lyingSummary = SUMMARY.replace("AMEX,2,114831", "AMEX,2,999999");
  const report = await runPreflightOnSealedZip({
    zipBytes: buildPack(AMEX_REALISTIC, lyingSummary),
    month: "2026-06",
    paymentDueDate: "2026-06-04",
    maxPackBytes: 100_000_000,
  });
  assert.equal(report.passed, false);
  assert.ok(
    report.results.some((r) => !r.passed && r.check === "summary-payment-path-reconciles"),
    "the drifted total must trip the payment-path reconciliation",
  );
});
