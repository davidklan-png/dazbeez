import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import {
  assembleProofsZip,
  buildProofFilename,
  buildTransitionNotice,
  formatYenAmount,
  sanitizeZipNameSegment,
  verifyProofFileSha256,
  type ProofZipEntry,
  type TransitionNoticeInput,
} from "@/lib/receipts/proofs";
import { computeSha256Hex } from "@/lib/receipts/storage";

const enc = new TextEncoder();

// ─── sanitizeZipNameSegment ─────────────────────────────────────────────────

test("sanitizeZipNameSegment strips forbidden chars + whitespace, keeps CJK", () => {
  assert.equal(sanitizeZipNameSegment("OpenAI"), "OpenAI");
  assert.equal(sanitizeZipNameSegment("セブン-イレブン 東中野末広橋店"), "セブン-イレブン東中野末広橋店");
  // Windows-forbidden chars removed.
  assert.equal(sanitizeZipNameSegment('a/b\\c:d*e?f"g<h>i|j'), "abcdefghij");
  // Empty → placeholder.
  assert.equal(sanitizeZipNameSegment("   "), "unknown");
  assert.equal(sanitizeZipNameSegment(""), "unknown");
});

test("sanitizeZipNameSegment caps length on code points (no surrogate slice)", () => {
  const long = "あ".repeat(50);
  assert.equal(sanitizeZipNameSegment(long, 10).length, 10); // 10 CJK chars
});

test("sanitizeZipNameSegment: NFD input (Mac-originated) is NFC-normalized", () => {
  // ブ (U+30D6) decomposes under NFD to フ (U+30D5) + combining dakuten (U+3099).
  // Mac-originated merchant strings can arrive in this decomposed form; the
  // entry name must be recomposed so it string-matches the NFC 照合CSV column.
  const nfd = "セブン".normalize("NFD");
  assert.notEqual(nfd, "セブン", "sanity: the NFD form is not the NFC form");
  const out = sanitizeZipNameSegment(nfd);
  assert.equal(out, "セブン", "output is NFC-composed");
  assert.equal(out, out.normalize("NFC"), "output is stable under re-normalization");
});

// ─── formatYenAmount ────────────────────────────────────────────────────────

test("formatYenAmount groups with commas, ￥ prefix, JPY only", () => {
  assert.equal(formatYenAmount(108341, "JPY"), "￥108,341");
  assert.equal(formatYenAmount(1900, "JPY"), "￥1,900");
  assert.equal(formatYenAmount(-100, "JPY"), "￥-100");
  assert.equal(formatYenAmount(1250, "USD"), "1250"); // non-JPY raw
});

// ─── verifyProofFileSha256 (layer-2 integrity) ──────────────────────────────

test("verifyProofFileSha256: passes when bytes hash to the recorded value", async () => {
  const bytes = enc.encode("the actual proof bytes shipped in the zip");
  const recorded = await computeSha256Hex(bytes);
  await assert.doesNotReject(() => verifyProofFileSha256(bytes, recorded));
});

test("verifyProofFileSha256: throws on mismatch (review fix for #102)", async () => {
  // A receipt_files row whose sha256_hash does NOT match the fetched bytes —
  // the object was corrupted/overwritten since capture. The rebuild must refuse
  // to seal rather than ship a proof whose recorded hash is a lie.
  const bytes = enc.encode("proof bytes");
  const wrongSha = "0".repeat(64);
  await assert.rejects(
    () => verifyProofFileSha256(bytes, wrongSha, 'Receipt r-1: proof file "k"'),
    /SHA-256 mismatch/,
  );
});

// ─── buildProofFilename ─────────────────────────────────────────────────────

test("buildProofFilename: No padded, segments joined, ext", () => {
  assert.equal(
    buildProofFilename({
      no: 3,
      categoryJa: "研究開発費",
      merchant: "OpenAI",
      amountMinor: 108341,
      currency: "JPY",
      ext: "pdf",
    }),
    "No03_研究開発費_OpenAI_￥108,341.pdf",
  );
});

test("buildProofFilename: multi-file suffix (-2) before ext", () => {
  assert.equal(
    buildProofFilename({
      no: 7,
      categoryJa: "接待交際費",
      merchant: "屋形舟",
      amountMinor: 69000,
      currency: "JPY",
      ext: "jpg",
      fileIndex: 2,
    }),
    "No07_接待交際費_屋形舟_￥69,000-2.jpg",
  );
});

test("buildProofFilename: No zero-pads to 2, 3 digits naturally", () => {
  const f = (n: number) =>
    buildProofFilename({
      no: n,
      categoryJa: "交通費",
      merchant: "TaxiGO",
      amountMinor: 1900,
      currency: "JPY",
      ext: "pdf",
    });
  assert.ok(f(1).startsWith("No01_"));
  assert.ok(f(33).startsWith("No33_"));
  assert.ok(f(120).startsWith("No120_"));
});

// ─── buildTransitionNotice (お知らせ) ───────────────────────────────────────

const baseNotice: TransitionNoticeInput = {
  monthLabel: "2026年6月",
  rowCount: 43,
  receiptCount: 40,
  missingReceiptLines: [],
  icAdvisories: [],
  exportRevision: 1,
};

test("buildTransitionNotice: static + dynamic sections, honest about gaps", () => {
  const txt = buildTransitionNotice(baseNotice);
  assert.ok(txt.includes("2026年6月"), "month label");
  assert.ok(txt.includes("科目＆No."), "explains the 科目＆No join key");
  assert.ok(txt.includes("Reconciliation.csv"), "explains the AMEX passthrough file");
  assert.ok(!txt.includes("NoXX"), "retired NoXX naming no longer described");
  assert.ok(txt.includes("参加者一覧.csv"), "attendee IDs resolve via 参加者一覧");
  assert.ok(txt.includes("出席者"), "attendees now a CSV column");
  assert.ok(txt.includes("SHA-256"), "integrity hashing mentioned");
  assert.ok(txt.includes("再圧縮"), "honest about recompression");
  assert.ok(txt.includes("原本は当方で保管"), "originals retained on request");
  assert.ok(txt.includes("明細行数: 43"), "dynamic row count");
  assert.ok(txt.includes("証憑ファイル数: 40"), "dynamic receipt count");
});

test("buildTransitionNotice: missing-receipt reasons + IC advisories surface", () => {
  const txt = buildTransitionNotice({
    ...baseNotice,
    missingReceiptLines: [
      { transactionDate: "2026-04-30", merchant: "ソフトバンクM", amountMinor: 14975, reason: "紛失" },
    ],
    icAdvisories: [
      { no: 33, transactionDate: "2026-06-02", merchant: "セブン-イレブン", amountMinor: 10000 },
    ],
  });
  assert.ok(txt.includes("領収書なしの明細"), "missing-receipt section header");
  assert.ok(txt.includes("紛失"), "recorded reason");
  assert.ok(txt.includes("2026-04-30 ソフトバンクM ¥14,975"), "line identified by date/merchant/amount");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(txt), "no UUIDs surfaced to the accountant");
  assert.ok(txt.includes("ICカードチャージ"), "IC advisory section");
  assert.ok(txt.includes("2026-06-02 セブン-イレブン ¥10,000"), "IC advisory identified by date, not No");
  assert.ok(!txt.includes("No33"), "internal No not surfaced");
});

test("buildTransitionNotice: revision context only when revision > 1", () => {
  const r1 = buildTransitionNotice(baseNotice);
  assert.ok(!r1.includes("改訂情報"), "no revision section for rev 1");
  const r2 = buildTransitionNotice({
    ...baseNotice,
    exportRevision: 2,
    supersedesExportId: "exp-old",
    correctionReason: "様式移行",
  });
  assert.ok(r2.includes("改訂情報"), "revision section for rev > 1");
  assert.ok(r2.includes("様式移行"), "correction reason present");
});

// ─── assembleProofsZip round-trip ───────────────────────────────────────────
// Build a zip and re-read it with fflate to confirm UTF-8 Japanese entry names
// survive (Windows Explorer safety) and the index/notice files are present.

function fakeEntry(over: Partial<ProofZipEntry>): ProofZipEntry {
  return {
    no: 1,
    categoryJa: "研究開発費",
    merchant: "OpenAI",
    amountMinor: 108341,
    currency: "JPY",
    ext: "pdf",
    bytes: enc.encode("%PDF-1.4 test"),
    transactionDate: "2026-03-04",
    attendees: "",
    paymentPath: "AMEX",
    ...over,
  };
}

// The summaryCsv passed to assembleProofsZip == the standalone summary artifact
// bytes (BOM+CRLF). Embedded as 集計.csv so a ZIP-only accountant gets the
// breakdown too.
const SUMMARY_CSV =
  "﻿Field,Value\r\nMonth,2026-06\r\n\r\n勘定科目,件数,合計金額\r\n研究開発費,1,108341\r\n\r\n総合計,1,108341\r\n";
// 参加者一覧 (attendees) — same shape as the standalone attendees artifact
// (BOM+CRLF), embedded byte-identical into the ZIP next to 集計.csv.
const ATTENDEES_CSV =
  "﻿AttendeeId,Name,Company,Title\r\n5,Alice Nakamura,Acme,Director\r\n";

test("assembleProofsZip: UTF-8 names round-trip + 集計/参加者一覧/お知らせ present, 目次 retired", () => {
  const entries = [
    fakeEntry({ no: 3, ext: "pdf", paymentPath: "AMEX" }),
    fakeEntry({
      no: 33,
      categoryJa: "旅費交通費",
      merchant: "セブン-イレブン 東中野末広橋店",
      amountMinor: 10000,
      ext: "jpg",
      paymentPath: "CASH",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    }),
  ];
  const zip = assembleProofsZip(
    "2026-06",
    entries,
    { ...baseNotice, receiptCount: 2 },
    SUMMARY_CSV,
    ATTENDEES_CSV,
  );
  const files = unzipSync(zip);
  const names = Object.keys(files);

  // Root + two folders with Japanese names.
  assert.ok(names.some((n) => n.startsWith("領収書等証憑_2026-06/")), "Japanese root folder");
  assert.ok(names.some((n) => n.includes("AMEX明細分/")), "AMEX folder");
  assert.ok(names.some((n) => n.includes("現金分/")), "cash folder (per payment path)");
  // The two proof files, with their No-prefixed Japanese names intact.
  assert.ok(
    names.some((n) => n.includes("No03_研究開発費_OpenAI_￥108,341.pdf")),
    "AMEX proof filename (Japanese + ￥) round-trips",
  );
  assert.ok(
    names.some((n) => n.includes("No33_旅費交通費_セブン-イレブン東中野末広橋店_￥10,000.jpg")),
    "cash proof filename (whitespace-stripped merchant) round-trips",
  );
  // Index + summary + attendees + notice.
  assert.ok(!names.some((n) => n.endsWith("目次.csv")), "目次.csv retired (照合CSVs are the index)");
  assert.ok(names.some((n) => n.endsWith("集計.csv")), "集計.csv present");
  assert.ok(names.some((n) => n.endsWith("参加者一覧.csv")), "参加者一覧.csv present");
  assert.ok(names.some((n) => n.endsWith("お知らせ.txt")), "お知らせ.txt present");
  // 集計.csv bytes == the standalone summary artifact (same bytes passed in).
  // Compare raw bytes — TextDecoder would strip the leading BOM and skew the
  // comparison.
  const shukeiKey = names.find((n) => n.endsWith("集計.csv"))!;
  const shukeiBytes = files[shukeiKey];
  const expectedShukei = enc.encode(SUMMARY_CSV);
  assert.equal(shukeiBytes.length, expectedShukei.length, "集計.csv byte length");
  assert.ok(
    shukeiBytes.every((b, i) => b === expectedShukei[i]),
    "集計.csv bytes identical to the standalone summary artifact",
  );
  // 参加者一覧.csv bytes == the standalone attendees artifact (same bytes in).
  const sankashaKey = names.find((n) => n.endsWith("参加者一覧.csv"))!;
  const sankashaBytes = files[sankashaKey];
  const expectedSankasha = enc.encode(ATTENDEES_CSV);
  assert.equal(sankashaBytes.length, expectedSankasha.length, "参加者一覧.csv byte length");
  assert.ok(
    sankashaBytes.every((b, i) => b === expectedSankasha[i]),
    "参加者一覧.csv bytes identical to the standalone attendees artifact",
  );
});

test("assembleProofsZip: reconciliation CSVs embedded at root when provided (review #2)", () => {
  const zip = assembleProofsZip(
    "2026-06",
    [fakeEntry({ no: 1 })],
    baseNotice,
    SUMMARY_CSV,
    ATTENDEES_CSV,
    { amex: "﻿amex-bytes", cash: "﻿cash-bytes", digital: null },
  );
  const files = unzipSync(zip);
  const keys = Object.keys(files);
  const amexKey = keys.find((k) => k.endsWith("AMEX2026-06_Reconciliation.csv"));
  const cashKey = keys.find((k) => k.endsWith("CASH2026-06_Reconciliation.csv"));
  assert.ok(amexKey, "AMEX reconciliation embedded");
  assert.ok(cashKey, "CASH reconciliation embedded");
  // Byte-identity with the standalone artifact (same doctrine as 集計.csv).
  assert.equal(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(files[amexKey!]),
    "﻿amex-bytes",
  );
  // Absent path → no entry.
  assert.ok(
    !keys.some((k) => k.includes("DIGITAL2026-06_Reconciliation")),
    "no DIGITAL entry when null",
  );
  // Root placement (directly under the 領収書等証憑_<month>/ prefix).
  assert.equal(amexKey!.split("/").length, 2, "embedded at ZIP root");
});

// ─── CP932 filename safety (regression for the 2026-07-24 field failure) ────
// The accountant's Japanese-Windows chain converts zip entry names to CP932.
// Half-width ¥ (U+00A5) is absent from CP932 and maps to byte 0x5C (a Windows
// path separator), corrupting extraction. Every emitted entry name must use
// full-width ￥ (U+FFE5) and be NFC (decomposed kana also breaks matching
// against the NFC 照合CSV 領収書ファイル名 column).

test("assembleProofsZip: no entry name contains half-width ¥ (U+00A5); all names NFC", () => {
  const entries = [
    fakeEntry({ no: 3, paymentPath: "AMEX" }),
    fakeEntry({
      no: 33,
      categoryJa: "旅費交通費",
      merchant: "セブン-イレブン 東中野末広橋店",
      amountMinor: 10000,
      ext: "jpg",
      paymentPath: "CASH",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    }),
  ];
  const zip = assembleProofsZip(
    "2026-06",
    entries,
    { ...baseNotice, receiptCount: 2 },
    SUMMARY_CSV,
    ATTENDEES_CSV,
    { amex: "﻿amex-bytes", cash: null, digital: null },
  );
  const names = Object.keys(unzipSync(zip));
  assert.ok(names.length > 0, "sanity: zip has entries");
  for (const name of names) {
    assert.ok(
      !name.includes("¥"),
      `entry name must not contain half-width ¥ (U+00A5): ${name}`,
    );
    assert.equal(
      name,
      name.normalize("NFC"),
      `entry name must be NFC-normalized: ${name}`,
    );
  }
});
