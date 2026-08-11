import test from "node:test";
import assert from "node:assert/strict";
import {
  runPackPreflight,
  PREFLIGHT_CHECK_KEYS,
  stripOperatorMessageSection,
  type PackPreflightEntry,
  type PackPreflightInput,
} from "@/lib/receipts/pack-preflight";
import { buildPackNames } from "@/lib/receipts/pack-naming";
import { buildPackNotice } from "@/lib/receipts/proofs";

const enc = new TextEncoder();
const byte = (s: string) => enc.encode(s);
const entry = (name: string, s = "x"): PackPreflightEntry => ({ name, bytes: byte(s) });

const names = buildPackNames("2026-06", "2026-06-04");

// A small, internally-consistent June pack: 1 AMEX charge + 1 cash receipt.
// Every check passes on this base; each broken fixture below mutates one thing.
const SUMMARY = [
  "Field,Value",
  "Month,2026-06",
  "GeneratedAt,t",
  "",
  "勘定科目,件数,合計金額",
  "会議費,1,6490",
  "消耗品費,1,1200",
  "",
  "支払方法,件数,合計金額",
  "AMEX,1,6490",
  "現金,1,1200",
  "デジタル,0,0",
  "",
  "総合計,2,7690",
].join("\r\n");

const AMEX_RECON = [
  "利用日,ご利用店名及び商品名,会員区分,支払区分名称,分割区分,金額,備考,科目＆No.,事業目的,人数,領収書ファイル名",
  '2026/04/17,小田原みなと食堂,,1回,,6490,,会議費Jun2026①,クライアント打ち合わせ,1,"会議費Jun2026①小田原みなと食堂￥6,490.jpg"',
].join("\r\n");

const CASH_RECON = [
  "No,利用日,店舗名,金額,科目＆No.,事業目的,人数,領収書ファイル名",
  '1,2026-06-10,セブン-イレブン,1200,消耗品費Jun2026①,,1,"消耗品費Jun2026①セブン-イレブン￥1,200.jpg"',
].join("\r\n");

const NOTICE = buildPackNotice(
  { monthLabel: "2026年6月", rowCount: 2, receiptCount: 2, missingReceiptLines: [] },
  names,
);

function baseEntries(): PackPreflightEntry[] {
  return [
    entry(`${names.rootFolder}/${names.summaryCsv}`, SUMMARY),
    entry(`${names.rootFolder}/${names.noticeFile}`, NOTICE),
    entry(`${names.rootFolder}/${names.amexReconciliationCsv}`, AMEX_RECON),
    entry(`${names.rootFolder}/${names.cashReconciliationCsv}`, CASH_RECON),
    entry(`${names.rootFolder}/${names.amexFolder}/会議費Jun2026①小田原みなと食堂￥6,490.jpg`, "img1"),
    entry(`${names.rootFolder}/${names.cashFolder}/消耗品費Jun2026①セブン-イレブン￥1,200.jpg`, "img2"),
  ];
}

function baseInput(): PackPreflightInput {
  return {
    month: "2026-06",
    paymentDueDate: "2026-06-04",
    containerNames: { zipName: names.zipName, rootFolder: names.rootFolder },
    entries: baseEntries(),
    noticeText: NOTICE,
    csvs: [
      { label: "集計", text: SUMMARY },
      { label: "AMEX", text: AMEX_RECON },
      { label: "CASH", text: CASH_RECON },
    ],
    amexStatementTotal: { kind: "total", cents: 6490 },
    maxPackBytes: 100_000_000,
  };
}

function clone(input: PackPreflightInput): PackPreflightInput {
  return {
    ...input,
    containerNames: { ...input.containerNames },
    entries: input.entries.map((e) => ({ ...e })),
    csvs: input.csvs.map((c) => ({ ...c })),
  };
}

function failsOnly(report: ReturnType<typeof runPackPreflight>, key: string): void {
  const target = report.results.find((r) => r.check === key);
  assert.ok(target, `check ${key} ran`);
  assert.equal(target!.passed, false, `check ${key} should fail`);
  assert.equal(report.passed, false, "a failing check must fail the whole report");
}

// ─── Coverage: every check key exists exactly once ──────────────────────────

test("preflight: check keys are unique and cover the spec", () => {
  assert.equal(new Set(PREFLIGHT_CHECK_KEYS).size, PREFLIGHT_CHECK_KEYS.length, "no duplicate keys");
  // The 17 checks from docs/2026-06-pack-approved-delta.md §16, plus the inverse
  // notice desync guard (notice-mentions-shipped-reconciliation-csvs) added to
  // close the shipped-but-unmentioned 照合CSV gap (§Minor).
  assert.equal(PREFLIGHT_CHECK_KEYS.length, 19);
  assert.ok(
    PREFLIGHT_CHECK_KEYS.includes("operator-message-matches-notice"),
    "O7 invariant check registered",
  );
});

// ─── Happy path: the consistent base pack passes every check ────────────────

test("preflight: a consistent pack passes every check", () => {
  const report = runPackPreflight(baseInput());
  const failed = report.results.filter((r) => !r.passed);
  assert.equal(report.passed, true, `unexpected failures: ${JSON.stringify(failed)}`);
  assert.equal(failed.length, 0);
});

// ─── One deliberately-broken fixture per check ──────────────────────────────

test("container-names-ascii: non-ASCII container name fails", () => {
  const input = clone(baseInput());
  input.containerNames.rootFolder = "202606_領収書"; // Japanese leaks into the container
  failsOnly(runPackPreflight(input), "container-names-ascii");
});

test("notice-filenames-exist: notice naming a missing file fails", () => {
  const input = clone(baseInput());
  // Notice claims a CSV that isn't in the ZIP (the §7 desync, on real bytes).
  input.noticeText = input.noticeText.replace(
    names.amexReconciliationCsv,
    "20260604_架空ファイル.csv",
  );
  failsOnly(runPackPreflight(input), "notice-filenames-exist");
});

test("notice-mentions-shipped-reconciliation-csvs: a shipped 照合CSV the notice omits fails (inverse guard)", () => {
  // The forward check (notice-filenames-exist) cannot catch this: the notice
  // names no absent file, yet a 照合CSV that ships goes unmentioned (the DIGITAL
  // gap, §Minor). Mutate the notice to drop the cash 照合CSV name while the CSV
  // still ships — only the inverse guard should fire.
  const input = clone(baseInput());
  input.noticeText = input.noticeText.replaceAll(
    names.cashReconciliationCsv,
    names.amexReconciliationCsv,
  );
  failsOnly(runPackPreflight(input), "notice-mentions-shipped-reconciliation-csvs");
});

test("payment-due-date-parseable: null payment date fails", () => {
  const input = clone(baseInput());
  input.paymentDueDate = null;
  failsOnly(runPackPreflight(input), "payment-due-date-parseable");
});

test("payment-due-date-parseable: unparseable date fails", () => {
  const input = clone(baseInput());
  input.paymentDueDate = "not-a-date";
  failsOnly(runPackPreflight(input), "payment-due-date-parseable");
});

test("csv-cells-resolve-to-entries: a 領収書ファイル名 cell with no entry fails", () => {
  const input = clone(baseInput());
  const amex = input.csvs.find((c) => c.label === "AMEX")!;
  amex.text = amex.text.replace(
    "会議費Jun2026①小田原みなと食堂￥6,490.jpg",
    "存在しないファイル.jpg",
  );
  failsOnly(runPackPreflight(input), "csv-cells-resolve-to-entries");
});

test("no-orphan-evidence: an unreferenced evidence file fails", () => {
  const input = clone(baseInput());
  input.entries.push(
    entry(`${names.rootFolder}/${names.amexFolder}/旅費交通費Jun2026①タクシー￥1,000.jpg`, "orphan"),
  );
  failsOnly(runPackPreflight(input), "no-orphan-evidence");
});

test("no-duplicate-evidence-in-folder: two same-named evidence files fail", () => {
  const input = clone(baseInput());
  // A second entry with the SAME path as the existing AMEX evidence — only
  // representable because entries is an array (a map would collapse them).
  input.entries.push(
    entry(`${names.rootFolder}/${names.amexFolder}/会議費Jun2026①小田原みなと食堂￥6,490.jpg`, "dup"),
  );
  failsOnly(runPackPreflight(input), "no-duplicate-evidence-in-folder");
});

test("circled-sequence-contiguous: a gap in the circled sequence fails", () => {
  const input = clone(baseInput());
  // Rename the AMEX evidence ① → ③ (skip ②) and fix the CSV reference to match,
  // so referential checks stay consistent and only the sequence check fails.
  const before = "会議費Jun2026①小田原みなと食堂￥6,490.jpg";
  const after = "会議費Jun2026③小田原みなと食堂￥6,490.jpg";
  const existing = input.entries.find((e) => e.name.endsWith(before))!;
  existing.name = existing.name.replace(before, after);
  const amex = input.csvs.find((c) => c.label === "AMEX")!;
  amex.text = amex.text.replace(before, after);
  failsOnly(runPackPreflight(input), "circled-sequence-contiguous");
});

test("summary-category-reconciles: a 集計 category total that drifts fails", () => {
  const input = clone(baseInput());
  const summary = input.csvs.find((c) => c.label === "集計")!;
  summary.text = summary.text.replace("会議費,1,6490", "会議費,1,9999");
  failsOnly(runPackPreflight(input), "summary-category-reconciles");
});

test("summary-payment-path-reconciles: AMEX total ≠ statement total fails", () => {
  const input = clone(baseInput());
  input.amexStatementTotal = { kind: "total", cents: 1 }; // 集計 says 6490
  failsOnly(runPackPreflight(input), "summary-payment-path-reconciles");
});

test("notice-counts-match-pack: a wrong 明細行数 in the notice fails", () => {
  const input = clone(baseInput());
  input.noticeText = input.noticeText.replace("明細行数: 2", "明細行数: 99");
  failsOnly(runPackPreflight(input), "notice-counts-match-pack");
});

test("entry-names-utf8-roundtrip: a lone surrogate in a name fails", () => {
  const input = clone(baseInput());
  // Root-level index file (depth 2 → not counted as evidence) with a lone
  // surrogate, which does not round-trip UTF-8.
  input.entries.push(entry(`${names.rootFolder}/202606_bad\uD800.txt`, "bad"));
  failsOnly(runPackPreflight(input), "entry-names-utf8-roundtrip");
});

test("entry-names-nfc: an NFD (decomposed) name fails", () => {
  const input = clone(baseInput());
  // ブ NFD-decomposes to フ + combining dakuten.
  const nfdName = `${names.rootFolder}/202606_${"フ"}゙test.txt`;
  assert.notEqual(nfdName, nfdName.normalize("NFC"), "sanity: fixture is actually NFD");
  input.entries.push(entry(nfdName, "nfd"));
  failsOnly(runPackPreflight(input), "entry-names-nfc");
});

test("entry-names-no-forbidden-chars: a colon in a filename segment fails", () => {
  const input = clone(baseInput());
  input.entries.push(entry(`${names.rootFolder}/${names.amexFolder}/会:議費.jpg`, "bad"));
  failsOnly(runPackPreflight(input), "entry-names-no-forbidden-chars");
});

test("entry-names-no-forbidden-chars: a non-BMP (emoji) char fails", () => {
  const input = clone(baseInput());
  input.entries.push(entry(`${names.rootFolder}/${names.amexFolder}/旅費😀.jpg`, "bad"));
  failsOnly(runPackPreflight(input), "entry-names-no-forbidden-chars");
});

test("no-half-width-yen: half-width ¥ (U+00A5) in a filename fails", () => {
  const input = clone(baseInput());
  input.entries.push(
    entry(`${names.rootFolder}/${names.amexFolder}/会議費Jun2026①店¥6490.jpg`, "bad"),
  );
  failsOnly(runPackPreflight(input), "no-half-width-yen");
});

test("pack-size-under-ceiling: pack over the ceiling fails", () => {
  const input = clone(baseInput());
  input.maxPackBytes = 1; // pack is far larger than 1 byte
  failsOnly(runPackPreflight(input), "pack-size-under-ceiling");
});

test("notice-policy: attendee reference in the notice fails", () => {
  const input = clone(baseInput());
  input.noticeText += "\r\n【参加者一覧】\r\n出席者: 村上";
  failsOnly(runPackPreflight(input), "notice-policy");
});

test("notice-policy: a manifest sentence in the notice fails", () => {
  const input = clone(baseInput());
  input.noticeText += "\r\nマニフェストで検証できます。";
  failsOnly(runPackPreflight(input), "notice-policy");
});

test("notice-policy: a 改訂情報 block in the notice fails", () => {
  const input = clone(baseInput());
  input.noticeText += "\r\n【改訂情報】\r\n改訂: 2";
  failsOnly(runPackPreflight(input), "notice-policy");
});

test("csv-no-attendee-id-column: a 会議-出席者ID column in a CSV fails", () => {
  const input = clone(baseInput());
  const cash = input.csvs.find((c) => c.label === "CASH")!;
  cash.text = cash.text.replace("事業目的,人数", "事業目的,会議-出席者ID,人数");
  failsOnly(runPackPreflight(input), "csv-no-attendee-id-column");
});

// ─── P2 #2: a real Netアンサー AMEX CSV has metadata before the 利用日 header
//    and 小計/合計 totals after the charges. The flat-fixture assumption (row 0
//    = header, every later row a charge) mis-counts both and fails a valid pack.
test("preflight: a realistic AMEX statement (metadata + header + charges + totals) passes", () => {
  const AMEX_REALISTIC = [
    "カード名称,セゾンプラチナビジネス・アメリカンエキスプレス・カード",
    "ご利用者名,DAVID KLAN",
    "お支払日,2026/07/06",
    "利用日,ご利用店名及び商品名,会員区分,支払区分名称,分割区分,金額,備考,科目＆No.,事業目的,人数,領収書ファイル名",
    '2026/04/17,小田原みなと食堂,,1回,,6490,,会議費Jun2026①,打ち合わせ,1,"会議費Jun2026①小田原みなと食堂￥6,490.jpg"',
    '2026/05/02,OpenAI,,1回,,108341,,研究開発費Jun2026①,API,1,"研究開発費Jun2026①OpenAI￥108,341.pdf"',
    "小計,,,,,114831", // total row — narrower than the 11-col charge rows
    "合計,,,,,114831",
  ].join("\r\n");
  const SUMMARY_2 = [
    "Field,Value", "Month,2026-06", "GeneratedAt,t", "",
    "勘定科目,件数,合計金額", "会議費,1,6490", "研究開発費,1,108341", "",
    "支払方法,件数,合計金額", "AMEX,2,114831", "現金,0,0", "デジタル,0,0", "",
    "総合計,2,114831",
  ].join("\r\n");
  const notice = buildPackNotice(
    { monthLabel: "2026年6月", rowCount: 2, receiptCount: 2, missingReceiptLines: [], hasAmex: true, hasCash: false, hasDigital: false },
    names,
  );
  const root = names.rootFolder;
  const input: PackPreflightInput = {
    month: "2026-06",
    paymentDueDate: "2026-06-04",
    containerNames: { zipName: names.zipName, rootFolder: names.rootFolder },
    noticeText: notice,
    csvs: [
      { label: "集計", text: SUMMARY_2 },
      { label: "AMEX", text: AMEX_REALISTIC },
    ],
    entries: [
      entry(`${root}/${names.summaryCsv}`, SUMMARY_2),
      entry(`${root}/${names.noticeFile}`, notice),
      entry(`${root}/${names.amexReconciliationCsv}`, AMEX_REALISTIC),
      entry(`${root}/${names.amexFolder}/会議費Jun2026①小田原みなと食堂￥6,490.jpg`, "img1"),
      entry(`${root}/${names.amexFolder}/研究開発費Jun2026①OpenAI￥108,341.pdf`, "img2"),
    ],
    amexStatementTotal: { kind: "total", cents: 114831 },
    maxPackBytes: 100_000_000,
  };
  const report = runPackPreflight(input);
  const failed = report.results.filter((r) => !r.passed);
  assert.equal(
    report.passed,
    true,
    `a realistic AMEX pack must pass; failures: ${JSON.stringify(failed)}`,
  );
  // Specifically: the charge-row count is 2 (the two charges), NOT 6
  // (metadata+header+charges+totals-1) — the pre-fix length-1 assumption.
  const counts = report.results.find((r) => r.check === "notice-counts-match-pack")!;
  assert.equal(counts.passed, true, "notice-counts-match-pack passes (2 charge rows, not the metadata/header/totals)");
});

// ─── Change 4 interaction: operator free text vs the notice-policy check ────
// The operator message is injected into 【今月のご連絡】 — the SAME file the
// policy check scans for 改訂情報 / attendee / manifest. The operator may
// legitimately write all three (D17 supersession note, D9 attendee retention,
// etc.). The policy check strips the operator section before scanning.
test("notice-policy: operator free text with 改訂情報/出席者/manifest does NOT trip the check (stripped)", () => {
  const notice = buildPackNotice(
    {
      monthLabel: "2026年6月",
      rowCount: 2,
      receiptCount: 2,
      missingReceiptLines: [],
      operatorMessage:
        "本パックは改訂情報として前回の6月分を差し替えます。出席者一覧は弊社で保管しております。マニフェストで検証できます。",
    },
    names,
  );
  const input = clone(baseInput());
  input.noticeText = notice;
  const report = runPackPreflight(input);
  const policy = report.results.find((r) => r.check === "notice-policy")!;
  assert.equal(
    policy.passed,
    true,
    "operator free text under 【今月のご連絡】 must not trip the policy check (改訂情報/出席者/manifest are the operator's words, not the generated notice)",
  );
});

// ─── stripOperatorMessageSection robustness ──────────────────────────────────

test("stripOperatorMessageSection: operator text with a bracketed line does NOT prematurely end the strip", () => {
  // The operator typed 【注意】 inside their note — a plausible bracketed line.
  // The strip must anchor on 【この資料について】 (the generated heading), NOT on
  // the operator's 【注意】. Otherwise the lines after 【注意】 would be
  // under-stripped (kept in the generated-text scan).
  const notice = buildPackNotice(
    {
      monthLabel: "2026年6月",
      rowCount: 2,
      receiptCount: 2,
      missingReceiptLines: [],
      operatorMessage:
        "差替え版です。\n【注意】前回のパックは破棄してください。\nよろしくお願いします。",
    },
    names,
  );
  const stripped = stripOperatorMessageSection(notice);
  // All operator text stripped (including the bracketed line + trailing text).
  assert.ok(!stripped.includes("差替え版"), "text before 【注意】 stripped");
  assert.ok(!stripped.includes("前回のパックは破棄"), "text after 【注意】 stripped");
  assert.ok(!stripped.includes("【注意】"), "the operator's bracketed line stripped");
  assert.ok(!stripped.includes("よろしくお願いします"), "trailing operator text stripped");
  // Generated structure intact.
  assert.ok(stripped.includes("【この資料について】"), "the generated heading is preserved");
  assert.ok(stripped.includes("科目＆No"), "generated content preserved");
});

test("stripOperatorMessageSection: no-op when the operator message is absent", () => {
  const notice = buildPackNotice(
    { monthLabel: "2026年6月", rowCount: 2, receiptCount: 2, missingReceiptLines: [] },
    names,
  );
  // No 【今月のご連絡】 heading ⇒ nothing to strip ⇒ identity.
  assert.equal(stripOperatorMessageSection(notice), notice);
});

// ─── O7 invariant: operator-message-matches-notice (19th check) ─────────────

test("operator-message-matches-notice: matching notice + stored value passes", () => {
  const input = clone(baseInput());
  input.noticeText = buildPackNotice(
    { monthLabel: "2026年6月", rowCount: 2, receiptCount: 2, missingReceiptLines: [], operatorMessage: "差替え版です。前回のパックは破棄してください。" },
    names,
  );
  input.operatorMessage = "差替え版です。前回のパックは破棄してください。";
  const check = runPackPreflight(input).results.find((r) => r.check === "operator-message-matches-notice")!;
  assert.equal(check.passed, true, "matching notice + stored value ⇒ pass");
});

test("operator-message-matches-notice: a deliberately desynced notice vs stored value fails (O7 drift)", () => {
  // The pack was sealed with "差替え版です" in the notice, but the stored
  // operator_message drifted to "別のメッセージ" (e.g. edited post-seal without
  // a rebuild). The ZIP says one thing; the email would say another.
  const input = clone(baseInput());
  input.noticeText = buildPackNotice(
    { monthLabel: "2026年6月", rowCount: 2, receiptCount: 2, missingReceiptLines: [], operatorMessage: "差替え版です。" },
    names,
  );
  input.operatorMessage = "別のメッセージ。";
  const check = runPackPreflight(input).results.find((r) => r.check === "operator-message-matches-notice")!;
  assert.equal(check.passed, false, "desync must be caught");
  if (!check.passed) assert.match(check.detail!, /does not match/);
});

test("operator-message-matches-notice: both empty (no operator message) passes", () => {
  const input = clone(baseInput());
  // baseInput's notice has no 【今月のご連絡】; operatorMessage undefined ⇒ null ⇒ "".
  input.operatorMessage = null;
  const check = runPackPreflight(input).results.find((r) => r.check === "operator-message-matches-notice")!;
  assert.equal(check.passed, true);
});
