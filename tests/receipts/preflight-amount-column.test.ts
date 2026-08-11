import test from "node:test";
import assert from "node:assert/strict";
import {
  amountColumnIndex,
  describeAmountColumnFailure,
  sumReconChargeAmounts,
} from "@/lib/receipts/pack-preflight";
import { PAYMENT_PATH_CSV_HEADERS } from "@/lib/receipts/reconciliation-files";

// Regression for the 2026-06 preflight false-failure. The AMEX 照合CSV is the
// card's Netアンサー passthrough; its amount column is `利用金額` (not `金額`),
// and the real detail header sits on line 4 after a 4-line preamble. The old
// `header.indexOf("金額")` (exact cell match) returned -1 → summed 0 → the check
// reported "the pack doesn't reconcile" instead of "the parser can't find the
// amount column." amountColumnIndex locates the amount SEMANTICALLY (the single
// cell containing 金額) and fails LOUDLY (zero or multiple) — never a silent zero.

// The real 11-column June-2026 AMEX detail header, verbatim as dumped from the
// sealed ZIP (line 4 of 20260604_AMEXカード利用明細.csv).
const JUNE_2026_AMEX_HEADER = [
  "利用日",
  "ご利用店名及び商品名",
  "本人・家族区分",
  "支払区分名称",
  "締前入金区分",
  "利用金額",
  "備考",
  "科目＆No.",
  "事業目的",
  "人数",
  "領収書ファイル名",
];

test("amountColumnIndex: the real June-2026 AMEX header → index 5 (利用金額)", () => {
  const r = amountColumnIndex(JUNE_2026_AMEX_HEADER);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.index, 5, "利用金額 is field[5]");
});

test("amountColumnIndex: PAYMENT_PATH_CSV_HEADERS (CASH/DIGITAL) → index 3 (金額)", () => {
  // The headers we BUILD for CASH/DIGITAL. The amount cell is exactly `金額` —
  // a substring match still finds it, so the fix is backward-compatible with the
  // built CSVs while also catching the AMEX passthrough.
  const r = amountColumnIndex([...PAYMENT_PATH_CSV_HEADERS]);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.index, 3);
    assert.equal(PAYMENT_PATH_CSV_HEADERS[r.index], "金額");
  }
});

test("amountColumnIndex: zero matches → named failure (kind 'zero')", () => {
  const r = amountColumnIndex(["利用日", "店名", "備考"]); // no 金額 anywhere
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "zero");
    assert.deepEqual(r.matches, []);
  }
});

test("amountColumnIndex: two matches → named failure (kind 'multiple') listing both cells", () => {
  // A hypothetical future layout where both 利用金額 and a new 支払金額 column
  // exist. This is (A)'s only real weakness; the exactly-one requirement turns
  // it into a loud named failure instead of a silent wrong-column read.
  const r = amountColumnIndex(["利用日", "利用金額", "支払金額", "備考"]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "multiple");
    assert.deepEqual(r.matches, ["利用金額", "支払金額"]);
  }
});

test("describeAmountColumnFailure: names the CSV, the kind, the matches, and the real header", () => {
  const zero = describeAmountColumnFailure({
    label: "AMEX",
    kind: "zero",
    matches: [],
    headerCells: ["利用日", "店名"],
  });
  assert.match(zero, /AMEX recon CSV: no header cell contains 金額/);
  assert.match(zero, /Header: \[利用日 \| 店名\]/);

  const multi = describeAmountColumnFailure({
    label: "CASH",
    kind: "multiple",
    matches: ["利用金額", "支払金額"],
    headerCells: ["No", "利用金額", "支払金額"],
  });
  assert.match(multi, /CASH recon CSV: 2 header cells contain 金額/);
  assert.match(multi, /"利用金額", "支払金額"/);
});

// ─── End-to-end: sumReconChargeAmounts on the REAL Netアンサー layout ──────────
// The bug layout: 4-line preamble (カード名称 / ご利用者名 / お支払日 / blank is
// not used here — 今回ご請求額 instead), then the 利用日 header whose amount cell
// is 利用金額, then charges, then 小計/合計. The old code summed 0; the fix must
// sum the charges and ignore the totals/metadata.
test("sumReconChargeAmounts: a real-layout AMEX CSV (利用金額) sums the charges, not 0", () => {
  const amex = [
    "カード名称,セゾンプラチナビジネス・アメリカンエキスプレス・カード",
    "お支払日,2026/06/04",
    "今回ご請求額,0000114831",
    "",
    "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,締前入金区分,利用金額,備考,科目＆No.,事業目的,人数,領収書ファイル名",
    '2026/04/17,小田原みなと食堂,,1回,,6490,,会議費Jun2026①,打ち合わせ,1,"会議費Jun2026①小田原みなと食堂￥6,490.jpg"',
    '2026/05/02,OpenAI,,1回,,108341,,研究開発費Jun2026①,API,1,"研究開発費Jun2026①OpenAI￥108,341.pdf"',
    ",【小計】,,,,114831",
    ",【合計】,,,,114831",
  ].join("\r\n");
  const r = sumReconChargeAmounts(amex);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.total, 114831, "6490 + 108341, ignoring 小計/合計");
});

test("sumReconChargeAmounts: an AMEX CSV whose amount cell is absent → ok:false (kind zero), not total:0", () => {
  // The regression shape: a header with no 金額 cell must NOT silently sum to 0.
  const amex = [
    "カード名称,カード",
    "利用日,店名,備考,科目＆No.,事業目的,人数,領収書ファイル名", // no 金額 cell
    '2026/04/17,小田原,,1回,,6490,,会議費Jun2026①,打ち合わせ,1,ignored.jpg',
  ].join("\r\n");
  const r = sumReconChargeAmounts(amex);
  assert.equal(r.ok, false, "must surface a named failure, not total:0");
  if (!r.ok) {
    assert.equal(r.kind, "zero");
    assert.ok(r.headerCells.length > 0, "carries the actual header cells for the detail");
  }
});
