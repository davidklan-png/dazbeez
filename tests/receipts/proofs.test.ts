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

// ─── formatYenAmount ────────────────────────────────────────────────────────

test("formatYenAmount groups with commas, ¥ prefix, JPY only", () => {
  assert.equal(formatYenAmount(108341, "JPY"), "¥108,341");
  assert.equal(formatYenAmount(1900, "JPY"), "¥1,900");
  assert.equal(formatYenAmount(-100, "JPY"), "¥-100");
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

test("buildProofsMokuziCsv: human TOC columns — no machine fields", () => {
  const csv = buildProofsMokuziCsv([
    {
      no: 3,
      filename: "No03_研究開発費_OpenAI_¥108,341.pdf",
      transactionDate: "2026-03-04",
      merchant: "OpenAI",
      amountMinor: 108341,
      currency: "JPY",
      categoryJa: "研究開発費",
      attendees: "",
    },
    {
      no: 7,
      filename: "No07_接待交際費_屋形舟_¥69,000.jpg",
      transactionDate: "2026-03-10",
      merchant: "屋形舟",
      amountMinor: 69000,
      currency: "JPY",
      categoryJa: "接待交際費",
      attendees: "山田太郎; 鈴木花子",
    },
  ]);
  assert.ok(csv.startsWith("﻿"), "目次 must be BOM-prefixed for Excel");
  assert.ok(csv.includes("\r\n"), "目次 must use CRLF for Windows Excel");
  // Exact header — the accountant's table of contents only.
  assert.ok(
    csv.includes("No,ファイル名,取引日,店舗,金額,勘定科目,出席者"),
    "目次 header is the human TOC",
  );
  // Machine fields removed (they live in the manifest).
  assert.ok(!csv.includes("statement_line_id"), "no statement_line_id column");
  assert.ok(!csv.includes("receipt_id"), "no receipt_id column");
  assert.ok(!csv.includes("出典"), "no 出典 column");
  // 出席者 populated for 接待交際費.
  assert.ok(csv.includes("山田太郎; 鈴木花子"), "attendees listed for 接待交際費");
  // Quoted filename field (contains a comma in the amount).
  assert.ok(csv.includes('"No03_研究開発費_OpenAI_¥108,341.pdf"'));
});

test("buildProofsMokuziCsv: 出席者 populated for 会議費/接待交際費, empty otherwise", () => {
  const row = (categoryJa: string, attendees: string) => ({
    no: 1,
    filename: "f.jpg",
    transactionDate: "2026-06-01",
    merchant: "M",
    amountMinor: 1000,
    currency: "JPY",
    categoryJa,
    attendees,
  });
  assert.ok(
    buildProofsMokuziCsv([row("会議費", "Alice; Bob")]).includes(",会議費,Alice; Bob"),
    "会議費 attendees populated",
  );
  assert.ok(
    buildProofsMokuziCsv([row("接待交際費", "Carol")]).includes(",接待交際費,Carol"),
    "接待交際費 attendees populated",
  );
  // Non-meeting/entertainment category → empty 出席者 (trailing empty field).
  const other = buildProofsMokuziCsv([row("旅費交通費", "")]);
  assert.match(other, /旅費交通費,\r\n/, "non-meeting category has empty 出席者");
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

test("assembleProofsZip: UTF-8 names round-trip + 目次/集計/お知らせ present", () => {
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
  );
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
  // Index + summary + notice.
  assert.ok(names.some((n) => n.endsWith("目次.csv")), "目次.csv present");
  assert.ok(names.some((n) => n.endsWith("集計.csv")), "集計.csv present");
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
});

test("assembleProofsZip: 目次 No column matches entry nos (CSV⇄目次 continuity)", () => {
  const entries = [
    fakeEntry({ no: 3 }),
    fakeEntry({ no: 7, merchant: "屋形舟", amountMinor: 69000 }),
    fakeEntry({ no: 33, merchant: "セブン", amountMinor: 10000 }),
  ];
  const zip = assembleProofsZip(
    "2026-06",
    entries,
    { ...baseNotice, receiptCount: 3 },
    SUMMARY_CSV,
  );
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
