import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import {
  assembleProofsZip,
  buildPackNotice,
  derivePackNoticeInput,
  formatYenAmount,
  sanitizeZipNameSegment,
  verifyProofFileSha256,
  type ProofZipEntry,
  type PackNoticeInput,
} from "@/lib/receipts/proofs";
import { buildPackNames } from "@/lib/receipts/pack-naming";
import { computeSha256Hex } from "@/lib/receipts/storage";
import type { ExportRow } from "@/lib/receipts/types";

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

// ─── buildPackNotice (ご連絡事項 — standing monthly notice) ─────────────────

const names = buildPackNames("2026-06", "2026-06-04");

const baseNotice: PackNoticeInput = {
  monthLabel: "2026年6月",
  rowCount: 43,
  receiptCount: 40,
  missingReceiptLines: [],
};

test("buildPackNotice: standing sections + interpolated filenames", () => {
  const txt = buildPackNotice(baseNotice, names);
  assert.ok(txt.includes("2026年6月"), "month label");
  assert.ok(txt.includes("科目＆No."), "explains the 科目＆No join key");
  // Filenames interpolated from the SAME names that name the ZIP entries —
  // never literals (the §7 desync guard).
  assert.ok(
    txt.includes(names.amexReconciliationCsv),
    `notice names the AMEX CSV: ${names.amexReconciliationCsv}`,
  );
  assert.ok(
    txt.includes(names.cashReconciliationCsv),
    `notice names the cash CSV: ${names.cashReconciliationCsv}`,
  );
  assert.ok(txt.includes("再圧縮"), "honest about recompression");
  assert.ok(txt.includes("原本は当方で保管"), "originals retained on request");
  assert.ok(txt.includes("明細行数: 43"), "dynamic row count");
  assert.ok(txt.includes("証憑ファイル数: 40"), "dynamic receipt count");
});

test("buildPackNotice: retire transition framing — no attendee/manifest/IC/revision", () => {
  const txt = buildPackNotice(baseNotice, names);
  assert.ok(!txt.includes("参加者一覧"), "no attendee roster reference (D9)");
  assert.ok(!txt.includes("出席者"), "no attendee reference (D9)");
  assert.ok(!/manifest|マニフェスト/.test(txt), "no manifest sentence (O1)");
  assert.ok(!txt.includes("ICカードチャージ"), "no IC advisory block (D13)");
  assert.ok(!txt.includes("改訂情報"), "no revision block (O2)");
  assert.ok(
    !txt.includes("従来の手作業納品"),
    "transition framing retired",
  );
});

test("buildPackNotice: missing-receipt section surfaces recorded reasons", () => {
  const txt = buildPackNotice(
    {
      ...baseNotice,
      missingReceiptLines: [
        { transactionDate: "2026-04-30", merchant: "ソフトバンクM", amountMinor: 14975, reason: "紛失" },
      ],
    },
    names,
  );
  assert.ok(txt.includes("領収書なしの明細"), "missing-receipt section header");
  assert.ok(txt.includes("紛失"), "recorded reason");
  assert.ok(txt.includes("2026-04-30 ソフトバンクM ¥14,975"), "line identified by date/merchant/amount");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(txt), "no UUIDs surfaced to the accountant");
});

test("buildPackNotice: 【今月のご連絡】 omitted when operatorMessage empty, present when set", () => {
  const empty = buildPackNotice(baseNotice, names);
  assert.ok(!empty.includes("【今月のご連絡】"), "section omitted when message empty");
  const withMsg = buildPackNotice(
    { ...baseNotice, operatorMessage: "今月はリモートワーク関連経費が増加しています。" },
    names,
  );
  assert.ok(withMsg.includes("【今月のご連絡】"), "section present when message set");
  assert.ok(
    withMsg.includes("リモートワーク関連経費"),
    "operator message text included verbatim",
  );
});

test("buildPackNotice: cash/digital-only pack (hasAmex=false) names the cash list, never the AMEX CSV", () => {
  // A draft built before the AMEX statement lands (or a finalized cash-only
  // month): no AMEX 照合CSV ships, so the notice must not name one — the §7
  // desync guard requires every mentioned file to exist in the ZIP. Note
  // buildPackNames with hasAmex=false does NOT require a payment-due date.
  const cashNames = buildPackNames("2026-06", null, false);
  const txt = buildPackNotice({ ...baseNotice, hasAmex: false }, cashNames);
  assert.ok(txt.includes(cashNames.cashReconciliationCsv), "names the cash list");
  assert.ok(
    !txt.includes(cashNames.amexReconciliationCsv),
    "does not name the (absent) AMEX CSV",
  );
  assert.ok(!txt.includes("カード明細の照合表"), "no AMEX reconciliation framing");
});

test("derivePackNoticeInput: month label + missing-receipt lines, no IC/revision plumbing", () => {
  const input = derivePackNoticeInput("2026-06", [], { rowCount: 5, receiptCount: 4 });
  assert.equal(input.monthLabel, "2026年6月");
  assert.equal(input.rowCount, 5);
  assert.equal(input.receiptCount, 4);
  assert.deepEqual(input.missingReceiptLines, []);
  assert.equal(input.hasAmex, false, "empty rows ⇒ no AMEX content");
  // The IC-advisory + revision fields are gone from the input shape.
  assert.equal(
    "icAdvisories" in input,
    false,
    "icAdvisories removed from the notice input",
  );
  assert.equal(
    "exportRevision" in input,
    false,
    "exportRevision removed from the notice input",
  );
});

test("derivePackNoticeInput: hasAmex derived from amex_line rows", () => {
  const withAmex = derivePackNoticeInput(
    "2026-06",
    [{ rowType: "amex_line", receiptId: "r-1" } as ExportRow],
    { rowCount: 1, receiptCount: 1 },
  );
  assert.equal(withAmex.hasAmex, true, "an amex_line row ⇒ AMEX content");
  const cashOnly = derivePackNoticeInput(
    "2026-06",
    [{ rowType: "receipt", receiptId: "r-2", paymentPath: "CASH" } as ExportRow],
    { rowCount: 1, receiptCount: 1 },
  );
  assert.equal(cashOnly.hasAmex, false, "receipt rows only ⇒ no AMEX content");
});

// ─── assembleProofsZip round-trip ───────────────────────────────────────────
// Build a zip and re-read it with fflate to confirm the new naming, the absence
// of the attendee roster, and that evidence filenames are UNCHANGED.

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
    filename: "研究開発費Jun2026①OpenAI￥108,341.pdf",
    ...over,
  };
}

// The summaryCsv passed to assembleProofsZip == the standalone summary artifact
// bytes (BOM+CRLF). Embedded as {yyyymm}_集計.csv so a ZIP-only accountant gets
// the breakdown too.
const SUMMARY_CSV =
  "﻿Field,Value\r\nMonth,2026-06\r\n\r\n勘定科目,件数,合計金額\r\n研究開発費,1,108341\r\n\r\n総合計,1,108341\r\n";
const AMEX_RECON_CSV = "﻿利用日,...,20260604_AMEX-bytes\r\n";
const CASH_RECON_CSV = "﻿No,利用日,...,202606-cash-bytes\r\n";

test("assembleProofsZip: new naming + no 参加者一覧 + evidence filenames UNCHANGED", () => {
  const entries = [
    fakeEntry({
      no: 3,
      ext: "pdf",
      paymentPath: "AMEX",
      filename: "会議費Jun2026③小田原みなと食堂￥6,490.jpg",
    }),
    fakeEntry({
      no: 33,
      categoryJa: "交際費",
      merchant: "こぶちさわ",
      amountMinor: 6967,
      ext: "jpg",
      paymentPath: "CASH",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      filename: "交際費Jun2026①こぶちさわ￥6,967.jpg",
    }),
  ];
  const zip = assembleProofsZip(
    names,
    entries,
    { ...baseNotice, receiptCount: 2 },
    SUMMARY_CSV,
    { amex: AMEX_RECON_CSV, cash: CASH_RECON_CSV, digital: null },
  );
  const entryNames = Object.keys(unzipSync(zip));

  // New container + folder naming.
  assert.ok(
    entryNames.some((n) => n.startsWith("202606_Dazbeez_Monthly_Expense_Report/")),
    "ASCII root folder",
  );
  assert.ok(
    entryNames.some((n) => n.includes("20260604_AMEXカード利用領収書/")),
    "AMEX folder named by payment-due date",
  );
  assert.ok(
    entryNames.some((n) => n.includes("202606_現金払い領収書/")),
    "cash folder named by statement month",
  );

  // Evidence filenames UNCHANGED (科目＆No pattern, full-width ￥, no prefix).
  assert.ok(
    entryNames.some((n) => n.includes("会議費Jun2026③小田原みなと食堂￥6,490.jpg")),
    "AMEX evidence filename byte-identical to the approved pack",
  );
  assert.ok(
    entryNames.some((n) => n.includes("交際費Jun2026①こぶちさわ￥6,967.jpg")),
    "cash evidence filename unchanged",
  );

  // Index files under new names.
  assert.ok(entryNames.some((n) => n.endsWith("202606_集計.csv")), "集計 → {yyyymm}_集計.csv");
  assert.ok(entryNames.some((n) => n.endsWith("202606_ご連絡事項.txt")), "お知らせ → {yyyymm}_ご連絡事項.txt");
  assert.ok(entryNames.some((n) => n.endsWith("20260604_AMEXカード利用明細.csv")), "AMEX recon → dated name");
  assert.ok(entryNames.some((n) => n.endsWith("202606_現金払いリスト.csv")), "cash recon → month name");
  assert.ok(
    !entryNames.some((n) => n.includes("DIGITAL")),
    "no DIGITAL entry when null",
  );

  // The attendee roster is NOT delivered (D9) — retained only.
  assert.ok(
    !entryNames.some((n) => n.includes("参加者一覧")),
    "参加者一覧 removed from the pack (D9)",
  );

  // Retired names are gone.
  assert.ok(!entryNames.some((n) => n.includes("AMEX明細分")), "old AMEX folder name gone");
  assert.ok(!entryNames.some((n) => n.includes("現金分/")), "old cash folder name gone");
  assert.ok(!entryNames.some((n) => n.endsWith("お知らせ.txt")), "old notice name gone");
  assert.ok(
    !entryNames.some((n) => n.split("/").pop() === "集計.csv"),
    "集計 gained a month prefix",
  );

  // 集計.csv bytes == the standalone summary artifact (same bytes passed in).
  const shukeiKey = entryNames.find((n) => n.endsWith("202606_集計.csv"))!;
  const shukeiBytes = unzipSync(zip)[shukeiKey];
  const expectedShukei = enc.encode(SUMMARY_CSV);
  assert.equal(shukeiBytes.length, expectedShukei.length, "集計.csv byte length");
  assert.ok(
    shukeiBytes.every((b, i) => b === expectedShukei[i]),
    "集計.csv bytes identical to the standalone summary artifact",
  );
});

test("assembleProofsZip: notice ⇄ ZIP reconciliation CSVs match both ways (§7 desync guard)", () => {
  // The notice names the AMEX + cash 照合CSV filenames; those names come from
  // the SAME PackNames object the assembler uses, so they must appear verbatim
  // as ZIP entries AND every shipped 照合CSV must be named. Both directions:
  const zip = assembleProofsZip(
    names,
    [fakeEntry({ no: 1, filename: "会議費Jun2026①小田原みなと食堂￥6,490.jpg" })],
    baseNotice,
    SUMMARY_CSV,
    { amex: AMEX_RECON_CSV, cash: CASH_RECON_CSV, digital: null },
  );
  const files = unzipSync(zip);
  const entryBasenames = new Set(Object.keys(files).map((p) => p.split("/").pop()!));
  const noticeText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    files[Object.keys(files).find((k) => k.endsWith("202606_ご連絡事項.txt"))!]!,
  );
  const mentioned = new Set(noticeText.match(/[^\s（）「」、。]+\.csv/g) ?? []);
  assert.ok(mentioned.size > 0, "notice mentions at least one .csv filename");
  // Forward §7: every notice-mentioned .csv exists as a ZIP entry.
  for (const name of mentioned) {
    assert.ok(entryBasenames.has(name), `notice-mentioned file is a real ZIP entry: ${name}`);
  }
  // Inverse: every shipped 照合CSV (root .csv, not 集計) is named in the notice.
  const shippedRecon = [...entryBasenames].filter((b) => b.endsWith(".csv") && !b.includes("集計"));
  assert.ok(shippedRecon.length > 0, "sanity: pack shipped reconciliation CSVs");
  for (const name of shippedRecon) {
    assert.ok(mentioned.has(name), `shipped 照合CSV is named in the notice: ${name}`);
  }
});

test("assembleProofsZip: a DIGITAL 照合CSV is named in the notice when digital rows ship", () => {
  // The previously-unmentioned case (docs/2026-08-07-phase-a-verification.md
  // §Minor): a month with digital rows ships a DIGITAL 照合CSV, and the notice
  // must name it — else it ships unmentioned (the gap the inverse guard closes).
  const zip = assembleProofsZip(
    names,
    [fakeEntry({ no: 1, paymentPath: "DIGITAL", filename: "消耗品費Jun2026①DAISO￥764.jpg" })],
    { ...baseNotice, hasCash: false, hasDigital: true },
    SUMMARY_CSV,
    { amex: AMEX_RECON_CSV, cash: null, digital: "﻿No,利用日,...,digital-bytes\r\n" },
  );
  const files = unzipSync(zip);
  const entryBasenames = new Set(Object.keys(files).map((p) => p.split("/").pop()!));
  const noticeText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    files[Object.keys(files).find((k) => k.endsWith("202606_ご連絡事項.txt"))!]!,
  );
  // The DIGITAL 照合CSV ships …
  assert.ok(entryBasenames.has(names.digitalReconciliationCsv), "DIGITAL 照合CSV is a ZIP entry");
  // … and is named in the notice (the regression this test guards).
  assert.ok(
    noticeText.includes(names.digitalReconciliationCsv),
    `notice names the DIGITAL 照合CSV: ${names.digitalReconciliationCsv}`,
  );
  // Inverse holds for every shipped 照合CSV (here: AMEX + DIGITAL; cash null).
  const mentioned = new Set(noticeText.match(/[^\s（）「」、。]+\.csv/g) ?? []);
  const shippedRecon = [...entryBasenames].filter((b) => b.endsWith(".csv") && !b.includes("集計"));
  for (const name of shippedRecon) {
    assert.ok(mentioned.has(name), `shipped 照合CSV is named: ${name}`);
  }
});

// ─── CP932/encoding safety (regression for the 2026-07-24 field failure) ─────
// The accountant's Japanese-Windows chain converts zip entry names to CP932.
// Half-width ¥ (U+00A5) is absent from CP932 and maps to byte 0x5C (a Windows
// path separator), corrupting extraction. Every emitted entry name must use
// full-width ￥ (U+FFE5) and be NFC; fflate must set the UTF-8 general-purpose
// bit on non-ASCII names.

// Parse the ZIP central directory to read each entry's general-purpose flag.
function centralDirFlags(zip: Uint8Array): Map<string, number> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, number>();
  for (let i = 0; i < zip.length - 4; i++) {
    // Central directory file header signature: PK\x01\x02 (0x02014b50 LE).
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
      const flags = dv.getUint16(i + 8, true);
      const nameLen = dv.getUint16(i + 28, true);
      const name = new TextDecoder().decode(zip.subarray(i + 46, i + 46 + nameLen));
      out.set(name, flags);
    }
  }
  return out;
}

test("assembleProofsZip: no half-width ¥, all names NFC, UTF-8 flag set on non-ASCII", () => {
  const entries = [
    fakeEntry({ no: 3, paymentPath: "AMEX", filename: "会議費Jun2026③小田原みなと食堂￥6,490.jpg" }),
    fakeEntry({
      no: 33,
      categoryJa: "旅費交通費",
      merchant: "セブン-イレブン 東中野末広橋店",
      amountMinor: 10000,
      ext: "jpg",
      paymentPath: "CASH",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      filename: "旅費交通費Jun2026①セブン-イレブン東中野末広橋店￥10,000.jpg",
    }),
  ];
  const zip = assembleProofsZip(
    names,
    entries,
    { ...baseNotice, receiptCount: 2 },
    SUMMARY_CSV,
    { amex: AMEX_RECON_CSV, cash: CASH_RECON_CSV, digital: null },
  );
  const entryNames = Object.keys(unzipSync(zip));
  assert.ok(entryNames.length > 0, "sanity: zip has entries");
  for (const name of entryNames) {
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
  // UTF-8 general-purpose bit (bit 11, 0x0800) must be set on every non-ASCII
  // entry name — the property that makes Windows Explorer/7-Zip decode the
  // Japanese names correctly (D-UTF8: keep current fflate behaviour).
  const flags = centralDirFlags(zip);
  let checkedNonAscii = false;
  for (const [name, flag] of flags) {
    if (/[^\x00-\x7f]/.test(name)) {
      checkedNonAscii = true;
      assert.equal(
        flag & 0x0800,
        0x0800,
        `UTF-8 flag not set on non-ASCII entry: ${name} (flags=0x${flag.toString(16)})`,
      );
    }
  }
  assert.ok(checkedNonAscii, "sanity: at least one non-ASCII entry was flag-checked");
});
