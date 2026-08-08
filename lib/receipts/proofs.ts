// Proofs-ZIP builder for the accountant bundle (PR 2).
//
// Pure helpers that turn a month's shipped receipts + their resolved proof
// bytes into the sealed `exports/<month>/<exportId>-proofs.zip` artifact. All
// container/folder/index naming is owned by lib/receipts/pack-naming.ts (the
// single naming authority) so the ZIP assembler, the notice builder, and the
// download resolver can never desync — the failure that prompted this module
// (docs/2026-06-pack-approved-delta.md §7). Evidence filenames inside the
// folders keep the accountant-approved 科目＆No pattern (reconciliation-files.ts
// buildEvidenceAssignments) and are NOT date-prefixed. The route does the R2
// fetches and passes the bytes here; these helpers are unit-testable without
// R2/D1.
//
// Folder contract (2026-08 rename, decisions D10–D12):
//   202606_Dazbeez_Monthly_Expense_Report/
//     20260604_AMEXカード利用領収書/   ← receipts matched to AMEX lines (payment-due date)
//       会議費Jun2026③小田原みなと食堂￥6,490.jpg   (科目＆No naming, UNCHANGED)
//     202606_現金払い領収書/           ← CASH receipts (statement month)
//     202606_デジタル払い領収書/       ← DIGITAL receipts (only when non-empty)
//     20260604_AMEXカード利用明細.csv  ← byte-copy of the AMEX 照合CSV (payment-due date)
//     202606_現金払いリスト.csv        ← CASH 照合CSV (statement month)
//     202606_デジタル払いリスト.csv    ← DIGITAL 照合CSV (only when non-empty)
//     202606_集計.csv
//     202606_ご連絡事項.txt
//   (参加者一覧.csv is no longer delivered — generated + retained, not shipped.
//    目次.csv retired earlier: the 照合CSVs' 領収書ファイル名 column is the index.)

import { zipSync } from "fflate";
import { computeSha256Hex } from "@/lib/receipts/storage";
import type { ExportRow } from "@/lib/receipts/types";
import type { PackNames } from "@/lib/receipts/pack-naming";

// Characters forbidden in zip filenames on Windows (Explorer refuses them).
// Whitespace is also stripped so the merchant segment stays compact and matches
// the manual delivery's spaceless style (OpenAI, 屋形舟, TaxiGO). CJK is kept.
const ZIP_FORBIDDEN_RE = /[\/\\:*?"<>|\s]+/g;

export function sanitizeZipNameSegment(s: string, maxLen = 30): string {
  // NFC first: Mac-originated merchant strings can arrive NFD (decomposed
  // dakuten kana), which extracts as decomposed on Windows and breaks
  // string-matching against the NFC 照合CSV 領収書ファイル名 column.
  const cleaned = s.normalize("NFC").replace(ZIP_FORBIDDEN_RE, "").trim();
  // capLen on code points, not UTF-16 units, so we don't slice a surrogate pair.
  const capped = Array.from(cleaned).slice(0, maxLen).join("");
  return capped.length > 0 ? capped : "unknown";
}

/** Full-width ￥ (U+FFE5)-prefixed comma-grouped yen amount for FILENAMES.
 *  JPY only (proofs are yen receipts); non-JPY falls back to the raw minor
 *  value. WHY full-width and not half-width ¥ (U+00A5): U+00A5 does not exist
 *  in CP932 (Shift-JIS as used by Japanese Windows). When a tool in the
 *  accountant's chain converts the name to CP932, U+00A5 fails outright or
 *  maps to byte 0x5C — which Windows treats as a path separator — corrupting
 *  or aborting extraction. Full-width ￥ IS in CP932 and is the correct
 *  character for Japanese-facing filenames. FILENAMES ONLY: notice text,
 *  CSVs, and other content keep half-width ¥ (content bytes are never
 *  charset-converted by zip tools). */
export function formatYenAmount(amountMinor: number, currency: string): string {
  if (currency !== "JPY") return String(amountMinor);
  const grouped = Math.abs(amountMinor)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `￥${amountMinor < 0 ? "-" : ""}${grouped}`;
}

export interface ProofFilenameParts {
  no: number;
  categoryJa: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  ext: "jpg" | "pdf";
  /** Disambiguator for multi-file receipts (1 = first/only file, 2, 3, …). */
  fileIndex?: number;
}

/** `No{NN}_{勘定科目Ja}_{merchant}_￥{amount}.{ext}` — zero-padded No, sanitized
 *  merchant. fileIndex>1 appends `-N` before the extension. */
export function buildProofFilename(p: ProofFilenameParts): string {
  const no = String(p.no).padStart(2, "0");
  const cat = sanitizeZipNameSegment(p.categoryJa || p.merchant, 16);
  const merchant = sanitizeZipNameSegment(p.merchant, 30);
  const amount = formatYenAmount(p.amountMinor, p.currency);
  const suffix = p.fileIndex && p.fileIndex > 1 ? `-${p.fileIndex}` : "";
  return `No${no}_${cat}_${merchant}_${amount}${suffix}.${p.ext}`;
}

// ─── ご連絡事項.txt (standing monthly pack notice) ──────────────────────────

export interface PackNoticeMissingLine {
  transactionDate: string | null;
  merchant: string;
  amountMinor: number;
  reason: string;
}

export interface PackNoticeInput {
  monthLabel: string; // e.g. "2026年6月"
  rowCount: number; // 照合CSV rows (AMEX lines + cash/digital)
  receiptCount: number; // distinct receipts with a proof in the zip
  /** AMEX statement lines shipped with no receipt, with the recorded reason.
   *  date/merchant/amount identify the line for the accountant — internal
   *  lineId UUIDs are NOT surfaced (draft-round feedback). */
  missingReceiptLines: PackNoticeMissingLine[];
  /** Operator free-text message for 【今月のご連絡】 (Phase B wires a UI to it).
   *  When empty/whitespace the whole section is omitted; do not emit an empty
   *  heading. NOT the email body (O7 — Phase B will feed one message into both
   *  this surface and the email). */
  operatorMessage?: string;
}

/** ご連絡事項.txt — a STANDING monthly communications channel between Dazbeez
 *  business admin and the accountant (O5). Retired the one-time "transition
 *  notice" framing: this no longer contrasts against the old hand-assembled
 *  delivery; it restates the durable "how to read this pack" content every
 *  month. Structure:
 *    【今月のご連絡】      operator free text (omitted when empty)
 *    【この資料について】  how to read the pack (filenames interpolated from the
 *                          same PackNames that name the ZIP entries — never
 *                          literals, so a rename can't desync the notice)
 *    【今月の内容】        counts
 *    【領収書なしの明細】  missing-receipt reasons (only when present)
 *  No attendee reference (the roster is retained, not delivered — D9), no
 *  SHA-256 manifest sentence (the manifest is internal-only — O1), no 改訂情報
 *  block (every delivery reads as a fresh first delivery — O2). */
export function buildPackNotice(input: PackNoticeInput, names: PackNames): string {
  const lines: string[] = [];
  lines.push(`${input.monthLabel} の領収証憑一式をお送りします。`);
  lines.push("");

  const operatorMessage = input.operatorMessage?.trim() ?? "";
  if (operatorMessage.length > 0) {
    lines.push("【今月のご連絡】");
    lines.push(operatorMessage);
    lines.push("");
  }

  lines.push("【この資料について】");
  lines.push(
    `・カード明細の照合表（${names.amexReconciliationCsv}）は、カード会社の明細CSVをそのまま再現し、右側に「科目＆No.」「事業目的」「人数」「領収書ファイル名」の列を追記したものです。現金決済分は ${names.cashReconciliationCsv} に分けて同封しています。`,
  );
  lines.push(
    "・各証憑のファイル名は「科目＆No.」（例：会議費Jun2026③）で始まり、丸数字方式です。照合表の「科目＆No.」「領収書ファイル名」列と対応しています。",
  );
  lines.push(
    "・紙の領収書は一つにまとめたPDFではなく、1件ずつの画像ファイルとして同封しています。",
  );
  lines.push(
    "・証憑画像は容量削減のため再圧縮しています（長辺1600px・JPEG品質75）。原本は当方で保管しており、ご要望があれば原本データをご提供します。",
  );
  lines.push(
    "・PDFの領収書は原本をそのまま同封しています（テキスト情報を保つため再圧縮していません）。",
  );
  lines.push("");
  lines.push("【今月の内容】");
  lines.push(`・明細行数: ${input.rowCount}`);
  lines.push(`・証憑ファイル数: ${input.receiptCount}`);
  if (input.missingReceiptLines.length > 0) {
    lines.push("");
    lines.push("【領収書なしの明細（記録された理由）】");
    for (const m of input.missingReceiptLines) {
      const date = m.transactionDate ?? "日付不明";
      lines.push(
        `・${date} ${m.merchant} ¥${m.amountMinor.toLocaleString("ja-JP")}: ${m.reason || "（理由記録なし）"}`,
      );
    }
  }
  lines.push("");
  lines.push("ご不明な点があればお知らせください。");
  return lines.join("\r\n");
}

// ─── SHA-256 verification (layer-2 integrity) ───────────────────────────────
// The proofs loop fetches each file from R2 then (in the route) verifies the
// bytes hash to the value recorded on the receipt_files row at capture. This
// upgrades the layer-2 check from "object exists" to "object is the one
// recorded" — at zero extra I/O (the bytes are already in memory). Extracted as
// a pure(ish) helper so the mismatch-throws behavior is unit-testable without
// R2/D1 (the route has no mocking harness).

/**
 * Hash `bytes` and throw if it doesn't equal `expectedSha256`. Used by the
 * proofs-zip rebuild to refuse sealing a bundle whose fetched proof object was
 * corrupted or overwritten since capture. `label` prefixes the error so the
 * caller can name the receipt + r2_key.
 */
export async function verifyProofFileSha256(
  bytes: Uint8Array | ArrayBuffer,
  expectedSha256: string,
  label = "Proof file",
): Promise<void> {
  const actual = await computeSha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(
      `${label}: SHA-256 mismatch (stored ${expectedSha256}, fetched ${actual}) — ` +
        `object corrupted or overwritten since capture; refusing to seal. ` +
        `Re-ingest or re-run backfill.`,
    );
  }
}

/**
 * Derive the pack-notice input from a month's bundle. Shared by the proofs-zip
 * build (rebuild path) and the finalize notification email (notify.ts) so the
 * notice text cannot drift between the two surfaces. Pure. The PackNames
 * (which carry the interpolated filenames) are supplied by the caller alongside
 * buildPackNotice — month + payment-due date resolve to names once, upstream.
 */
export function derivePackNoticeInput(
  month: string,
  rows: ExportRow[],
  counts: { rowCount: number; receiptCount: number },
): PackNoticeInput {
  const missingReceiptLines: PackNoticeMissingLine[] = rows
    .filter((r) => r.rowType === "amex_line" && r.missingReceiptReason)
    .map((r) => ({
      transactionDate: r.transactionDate,
      merchant: r.merchant ?? "店舗不明",
      amountMinor: r.amountMinor ?? 0,
      reason: r.missingReceiptReason ?? "",
    }));
  const monthLabel = `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
  return {
    monthLabel,
    rowCount: counts.rowCount,
    receiptCount: counts.receiptCount,
    missingReceiptLines,
  };
}

// ─── ZIP assembly ────────────────────────────────────────────────────────────

export type ProofPaymentPath = "AMEX" | "CASH" | "DIGITAL";

export interface ProofZipEntry {
  no: number;
  categoryJa: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  ext: "jpg" | "pdf";
  bytes: Uint8Array;
  transactionDate: string | null;
  /** 出席者 for the (retired) 目次 (会議費/接待交際費 only); blank otherwise.
   *  Carried for completeness — no delivered artifact reads it since 目次 and
   *  参加者一覧 were retired from the pack. */
  attendees: string;
  paymentPath: ProofPaymentPath;
  /** Pre-assigned evidence filename (reconciliation-files.ts
   *  buildEvidenceAssignments). When present it names the ZIP entry —
   *  collisions still get a -2/-3 suffix before the extension. When absent
   *  the legacy No{NN}_ naming applies. */
  filename?: string;
}

function folderForPath(
  paymentPath: ProofPaymentPath,
  names: PackNames,
): string {
  if (paymentPath === "AMEX") return names.amexFolder;
  return paymentPath === "DIGITAL" ? names.digitalFolder : names.cashFolder;
}

/** Build the sealed proofs ZIP. fflate uses a single compression level; we use
 *  level 0 (store) so the bulk JPEG/PDF bytes aren't recompressed (wasted CPU,
 *  ~0 size gain). The index files are tiny, so storing them uncompressed is
 *  negligible. UTF-8 entry names: fflate sets the UTF-8 general-purpose bit for
 *  non-ASCII paths, so the Japanese names open correctly in Windows Explorer
 *  (encoding decision D-UTF8: keep current fflate behaviour; no CP932).
 *
 *  All folder/index names come from the single naming authority (`names`). The
 *  参加者一覧 roster is intentionally NOT embedded — retained internally, not
 *  delivered (D9). `summaryCsv` is the SAME bytes as the standalone summary
 *  artifact (BOM+CRLF), embedded as {yyyymm}_集計.csv so the accountant who
 *  only opens the ZIP still gets the cost breakdown. */
export function assembleProofsZip(
  names: PackNames,
  entries: ProofZipEntry[],
  noticeInput: PackNoticeInput,
  summaryCsv: string,
  /** Reconciliation CSVs — byte-identical copies of the standalone artifacts,
   *  embedded at ZIP root under their pack names so the ZIP alone is the
   *  complete accountant package (same doctrine as 集計.csv). Absent entries
   *  are skipped (e.g. no DIGITAL rows this month). */
  reconciliationCsvs?: { amex?: string | null; cash?: string | null; digital?: string | null },
): Uint8Array {
  const root = names.rootFolder;
  const files: Record<string, Uint8Array> = {};
  // Per-folder dedupe so a (rare) filename collision gets a -2/-3 suffix.
  const seenPerFolder = new Map<string, Set<string>>();

  const encoder = new TextEncoder();

  for (const entry of entries) {
    const folder = folderForPath(entry.paymentPath, names);
    let filename: string;
    const seen = seenPerFolder.get(folder) ?? new Set<string>();
    if (entry.filename) {
      // Pre-assigned evidence name (科目＆No convention). Collisions cannot
      // happen for distinct receipts (per-category sequence is unique), but a
      // defensive -2/-3 suffix keeps the ZIP writable if inputs ever repeat.
      filename = entry.filename;
      let fileIndex = 1;
      while (seen.has(filename)) {
        fileIndex += 1;
        const dot = entry.filename.lastIndexOf(".");
        filename = `${entry.filename.slice(0, dot)}-${fileIndex}${entry.filename.slice(dot)}`;
      }
    } else {
      const base = buildProofFilename({
        no: entry.no,
        categoryJa: entry.categoryJa,
        merchant: entry.merchant,
        amountMinor: entry.amountMinor,
        currency: entry.currency,
        ext: entry.ext,
      });
      filename = base;
      let fileIndex = 1;
      while (seen.has(filename)) {
        fileIndex += 1;
        filename = buildProofFilename({
          no: entry.no,
          categoryJa: entry.categoryJa,
          merchant: entry.merchant,
          amountMinor: entry.amountMinor,
          currency: entry.currency,
          ext: entry.ext,
          fileIndex,
        });
      }
    }
    seen.add(filename);
    seenPerFolder.set(folder, seen);
    files[`${root}/${folder}/${filename}`] = entry.bytes;
  }

  files[`${root}/${names.summaryCsv}`] = encoder.encode(summaryCsv);
  files[`${root}/${names.noticeFile}`] = encoder.encode(
    buildPackNotice(noticeInput, names),
  );
  if (reconciliationCsvs?.amex) {
    files[`${root}/${names.amexReconciliationCsv}`] = encoder.encode(reconciliationCsvs.amex);
  }
  if (reconciliationCsvs?.cash) {
    files[`${root}/${names.cashReconciliationCsv}`] = encoder.encode(reconciliationCsvs.cash);
  }
  if (reconciliationCsvs?.digital) {
    files[`${root}/${names.digitalReconciliationCsv}`] = encoder.encode(reconciliationCsvs.digital);
  }

  return zipSync(files, { level: 0 });
}
