import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import {
  assembleProofsZip,
  buildProofFilename,
  buildProofsMokuziCsv,
  buildTransitionNotice,
  formatYenAmount,
  sanitizeZipNameSegment,
  type ProofZipEntry,
  type TransitionNoticeInput,
} from "@/lib/receipts/proofs";

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

// ─── formatYenAmount ────────────────────────────────────────────────────────

test("formatYenAmount groups with commas, ¥ prefix, JPY only", () => {
  assert.equal(formatYenAmount(108341, "JPY"), "¥108,341");
  assert.equal(formatYenAmount(1900, "JPY"), "¥1,900");
  assert.equal(formatYenAmount(-100, "JPY"), "¥-100");
  assert.equal(formatYenAmount(1250, "USD"), "1250"); // non-JPY raw
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
    "No03_研究開発費_OpenAI_¥108,341.pdf",
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
    "No07_接待交際費_屋形舟_¥69,000-2.jpg",
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

// ─── buildProofsMokuziCsv (目次) ────────────────────────────────────────────

test("buildProofsMokuziCsv: BOM + CRLF + header + 出典 mapping", () => {
  const csv = buildProofsMokuziCsv([
    {
      no: 3,
      filename: "No03_研究開発費_OpenAI_¥108,341.pdf",
      transactionDate: "2026-03-04",
      merchant: "OpenAI",
      amountMinor: 108341,
      currency: "JPY",
      categoryJa: "研究開発費",
      statementLineId: "amex-line-3",
      receiptId: "r-3",
      sha256: "abc123",
      source: "proof_copy",
    },
    {
      no: 7,
      filename: "No07_接待交際費_屋形舟_¥69,000.jpg",
      transactionDate: "2026-03-10",
      merchant: "屋形舟",
      amountMinor: 69000,
      currency: "JPY",
      categoryJa: "接待交際費",
      statementLineId: null,
      receiptId: "r-7",
      sha256: "def456",
      source: "original",
    },
  ]);
  assert.ok(csv.startsWith("﻿"), "目次 must be BOM-prefixed for Excel");
  assert.ok(csv.includes("\r\n"), "目次 must use CRLF for Windows Excel");
  assert.ok(csv.includes("No,ファイル名,取引日"), "目次 header row");
  // 出典 maps proof_copy → 圧縮コピー, original → 原本.
  assert.ok(csv.includes("圧縮コピー"), "proof_copy source label");
  assert.ok(csv.includes("原本"), "original source label");
  // Quoted filename field (contains a comma in the amount).
  assert.ok(csv.includes('"No03_研究開発費_OpenAI_¥108,341.pdf"'));
  // Sorted by No ascending.
  const a = csv.indexOf("No03");
  const b = csv.indexOf("r-7");
  assert.ok(a < b, "rows sorted by No");
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
  assert.ok(txt.includes("NoXX"), "explains the No join key");
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
    missingReceiptLines: [{ lineId: "amex-line-9", reason: "紛失" }],
    icAdvisories: [{ no: 33, merchant: "セブン-イレブン", amountMinor: 10000 }],
  });
  assert.ok(txt.includes("領収書なしの明細"), "missing-receipt section header");
  assert.ok(txt.includes("紛失"), "recorded reason");
  assert.ok(txt.includes("ICカードチャージ"), "IC advisory section");
  assert.ok(txt.includes("No33"), "IC advisory No");
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
    source: "proof_copy",
    bytes: enc.encode("%PDF-1.4 test"),
    transactionDate: "2026-03-04",
    receiptId: "r-1",
    statementLineId: "amex-line-1",
    sha256: "abc123",
    paymentPath: "AMEX",
    ...over,
  };
}

test("assembleProofsZip: UTF-8 names round-trip + folders + index/notice present", () => {
  const entries = [
    fakeEntry({ no: 3, ext: "pdf", paymentPath: "AMEX" }),
    fakeEntry({
      no: 33,
      categoryJa: "旅費交通費",
      merchant: "セブン-イレブン 東中野末広橋店",
      amountMinor: 10000,
      ext: "jpg",
      source: "original",
      paymentPath: "CASH",
      receiptId: "r-33",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    }),
  ];
  const zip = assembleProofsZip("2026-06", entries, { ...baseNotice, receiptCount: 2 });
  const files = unzipSync(zip);
  const names = Object.keys(files);

  // Root + two folders with Japanese names.
  assert.ok(names.some((n) => n.startsWith("領収書等証憓_2026-06/")), "Japanese root folder");
  assert.ok(names.some((n) => n.includes("AMEX明細分/")), "AMEX folder");
  assert.ok(names.some((n) => n.includes("追加経費_現金デジタル分/")), "cash/digital folder");
  // The two proof files, with their No-prefixed Japanese names intact.
  assert.ok(
    names.some((n) => n.includes("No03_研究開発費_OpenAI_¥108,341.pdf")),
    "AMEX proof filename (Japanese + ¥) round-trips",
  );
  assert.ok(
    names.some((n) => n.includes("No33_旅費交通費_セブン-イレブン東中野末広橋店_¥10,000.jpg")),
    "cash proof filename (whitespace-stripped merchant) round-trips",
  );
  // Index + notice.
  assert.ok(names.some((n) => n.endsWith("目次.csv")), "目次.csv present");
  assert.ok(names.some((n) => n.endsWith("お知らせ.txt")), "お知らせ.txt present");
});

test("assembleProofsZip: 目次 No column matches entry nos (CSV⇄目次 continuity)", () => {
  const entries = [
    fakeEntry({ no: 3, receiptId: "r-3" }),
    fakeEntry({ no: 7, receiptId: "r-7", merchant: "屋形舟", amountMinor: 69000 }),
    fakeEntry({ no: 33, receiptId: "r-33", merchant: "セブン", amountMinor: 10000 }),
  ];
  const zip = assembleProofsZip("2026-06", entries, { ...baseNotice, receiptCount: 3 });
  const files = unzipSync(zip);
  const mokuziKey = Object.keys(files).find((k) => k.endsWith("目次.csv"))!;
  const mokuzi = new TextDecoder().decode(files[mokuziKey]);
  // The entry nos (3, 7, 33) must each appear as the leading No column.
  for (const no of [3, 7, 33]) {
    assert.ok(
      new RegExp(`^${no},`, "m").test(mokuzi.replace(/﻿/, "")),
      `目次 must list No=${no}`,
    );
  }
});
