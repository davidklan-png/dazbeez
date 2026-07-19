// Proofs-ZIP builder for the accountant bundle (PR 2).
//
// Pure helpers that turn a month's shipped receipts + their resolved proof
// bytes into the sealed `exports/<month>/<exportId>-proofs.zip` artifact. All
// naming is Japanese (the accountant's working language) and ties each proof to
// a statement line via the `No` join column (the first column of the receipts
// CSV — see buildMonthlyExportCsv). The route does the R2 fetches and passes the
// bytes here; these helpers are unit-testable without R2/D1.
//
// Folder contract (review #2 + draft-round feedback 2026-07-18):
//   領収書等証憑_<month>/
//     AMEX明細分/  ← receipts matched to AMEX statement lines
//       会議費Jun2026③小田原みなと食堂¥6,490.jpg   (科目＆No naming)
//     現金分/      ← CASH receipts (calendar-month membership)
//     デジタル分/  ← DIGITAL receipts
//     AMEX/CASH/DIGITAL{month}_Reconciliation.csv ← byte-copies of the 照合CSVs
//     集計.csv / 参加者一覧.csv / お知らせ.txt
//   (目次.csv retired — the 照合CSVs' 領収書ファイル名 column is the index.)

import { zipSync } from "fflate";
import { computeSha256Hex } from "@/lib/receipts/storage";
import { isIcCardTopUpCandidate } from "@/lib/receipts/blockers";
import type { ExportRow, ReceiptRecord } from "@/lib/receipts/types";

// Characters forbidden in zip filenames on Windows (Explorer refuses them).
// Whitespace is also stripped so the merchant segment stays compact and matches
// the manual delivery's spaceless style (OpenAI, 屋形舟, TaxiGO). CJK is kept.
const ZIP_FORBIDDEN_RE = /[\/\\:*?"<>|\s]+/g;

export function sanitizeZipNameSegment(s: string, maxLen = 30): string {
  const cleaned = s.replace(ZIP_FORBIDDEN_RE, "").trim();
  // capLen on code points, not UTF-16 units, so we don't slice a surrogate pair.
  const capped = Array.from(cleaned).slice(0, maxLen).join("");
  return capped.length > 0 ? capped : "unknown";
}

/** ¥-prefixed comma-grouped yen amount for filenames. JPY only (proofs
 *  are yen receipts); non-JPY falls back to the raw minor value. */
export function formatYenAmount(amountMinor: number, currency: string): string {
  if (currency !== "JPY") return String(amountMinor);
  const grouped = Math.abs(amountMinor)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `¥${amountMinor < 0 ? "-" : ""}${grouped}`;
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

/** `No{NN}_{勘定科目Ja}_{merchant}_¥{amount}.{ext}` — zero-padded No, sanitized
 *  merchant. fileIndex>1 appends `-N` before the extension. */
export function buildProofFilename(p: ProofFilenameParts): string {
  const no = String(p.no).padStart(2, "0");
  const cat = sanitizeZipNameSegment(p.categoryJa || p.merchant, 16);
  const merchant = sanitizeZipNameSegment(p.merchant, 30);
  const amount = formatYenAmount(p.amountMinor, p.currency);
  const suffix = p.fileIndex && p.fileIndex > 1 ? `-${p.fileIndex}` : "";
  return `No${no}_${cat}_${merchant}_${amount}${suffix}.${p.ext}`;
}

// ─── お知らせ.txt (transition notice) ────────────────────────────────────────

export interface TransitionNoticeInput {
  monthLabel: string; // e.g. "2026年6月"
  rowCount: number; // receipts CSV rows (AMEX lines + cash/digital)
  receiptCount: number; // distinct receipts with a proof in the zip
  /** AMEX statement lines shipped with no receipt, with the recorded reason.
   *  date/merchant/amount identify the line for the accountant — internal
   *  lineId UUIDs are NOT surfaced (draft-round feedback). */
  missingReceiptLines: {
    transactionDate: string | null;
    merchant: string;
    amountMinor: number;
    reason: string;
  }[];
  /** IC-card top-up advisories (non-blocking) among the proofs, if any.
   *  Identified by date/merchant/amount (目次 retired, so No means nothing
   *  to the accountant anymore). */
  icAdvisories: {
    no: number;
    transactionDate: string | null;
    merchant: string;
    amountMinor: number;
  }[];
  exportRevision: number;
  supersedesExportId?: string | null;
  correctionReason?: string | null;
}

/** お知らせ.txt — honest notice of where this bundle differs from the prior
 *  hand-assembled delivery. Static "what changed" + dynamic month/counts +
 *  missing-receipt reasons + IC advisories + revision context. Not promotional:
 *  gaps and fallbacks are stated plainly. */
export function buildTransitionNotice(input: TransitionNoticeInput): string {
  const lines: string[] = [];
  lines.push(`${input.monthLabel} の領収証憑一式をお送りします。`);
  lines.push("");
  lines.push("【お知りいただきたい変更点（従来の手作業納品との違い）】");
  lines.push(
    "・カード明細の照合表（AMEX＜年月＞_Reconciliation.csv）は、カード会社の明細CSVをそのまま再現し、右側に「科目＆No.」「会議-出席者ID」「人数」「領収書ファイル名」の列を追記したものです。現金・デジタル決済分は CASH／DIGITAL の照合CSVに分けて同封しています。",
  );
  lines.push(
    "・各証憑のファイル名は「科目＆No.」（例：会議費Jun2026③）で始まり、従来の手作業納品と同じ丸数字方式です。照合CSVの「科目＆No.」「領収書ファイル名」列と対応しています。",
  );
  lines.push(
    "・接待・会議の出席者は別紙PDFではなく、照合CSVの出席者ID列に記載しています。IDと氏名・会社・役職の対応は 参加者一覧.csv をご参照ください。",
  );
  lines.push(
    "・紙の領収書は一つにまとめたPDFではなく、1件ずつの画像ファイルとして同封しています。",
  );
  lines.push(
    "・全ファイルの SHA-256 ハッシュをマニフェスト(manifest)に記録し、改ざんがないことを検証できます。",
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
  if (input.icAdvisories.length > 0) {
    lines.push("");
    lines.push(
      "【ICカードチャージの可能性がある取引（参考・確定ではありません）】",
    );
    for (const ic of input.icAdvisories) {
      lines.push(
        `・${ic.transactionDate ?? "日付不明"} ${ic.merchant} ¥${ic.amountMinor.toLocaleString("ja-JP")} — 交通系ICカードのチャージの可能性があります。業務利用の確定・精算方法は会計判断をお願いします。`,
      );
    }
  }
  if (input.exportRevision > 1) {
    lines.push("");
    lines.push("【改訂情報】");
    lines.push(`・改訂: ${input.exportRevision}（差替元: ${input.supersedesExportId ?? "不明"}）`);
    lines.push(`・改訂理由: ${input.correctionReason ?? "（記録なし）"}`);
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
 * Derive the transition-notice input from a month's bundle + revision context.
 * Shared by the proofs-zip build (rebuild path) and the finalize notification
 * email so the notice text cannot drift between the two surfaces. Pure.
 */
export function deriveTransitionNoticeInput(
  month: string,
  rows: ExportRow[],
  receipts: ReceiptRecord[],
  counts: { rowCount: number; receiptCount: number },
  revCtx: {
    exportRevision: number;
    supersedesExportId?: string | null;
    correctionReason?: string | null;
  },
): TransitionNoticeInput {
  const missingReceiptLines = rows
    .filter((r) => r.rowType === "amex_line" && r.missingReceiptReason)
    .map((r) => ({
      transactionDate: r.transactionDate,
      merchant: r.merchant ?? "店舗不明",
      amountMinor: r.amountMinor ?? 0,
      reason: r.missingReceiptReason ?? "",
    }));
  const icAdvisories: TransitionNoticeInput["icAdvisories"] = [];
  const icSeen = new Set<string>();
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  rows.forEach((row, i) => {
    if (!row.receiptId || icSeen.has(row.receiptId)) return;
    const receipt = receiptById.get(row.receiptId);
    if (receipt && isIcCardTopUpCandidate(receipt)) {
      icSeen.add(row.receiptId);
      icAdvisories.push({
        no: i + 1,
        transactionDate: row.transactionDate,
        merchant: row.merchant ?? "",
        amountMinor: row.amountMinor ?? 0,
      });
    }
  });
  const monthLabel = `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
  return {
    monthLabel,
    rowCount: counts.rowCount,
    receiptCount: counts.receiptCount,
    missingReceiptLines,
    icAdvisories,
    ...revCtx,
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
  /** 出席者 for the 目次 (会議費/接待交際費 only); blank otherwise. */
  attendees: string;
  paymentPath: ProofPaymentPath;
  /** Pre-assigned evidence filename (reconciliation-files.ts
   *  buildEvidenceAssignments). When present it names the ZIP entry —
   *  collisions still get a -2/-3 suffix before the extension. When absent
   *  the legacy No{NN}_ naming applies. */
  filename?: string;
}

const ROOT_PREFIX = (month: string) => `領収書等証憑_${month}/`;
const AMEX_FOLDER = "AMEX明細分/";
// Draft-round feedback 2026-07-18: one folder per payment path, mirroring the
// per-path 照合CSVs (the shared 追加経費_現金デジタル分 folder made the CASH
// receipts hard to find).
const CASH_FOLDER = "現金分/";
const DIGITAL_FOLDER = "デジタル分/";

function folderFor(paymentPath: ProofPaymentPath): string {
  if (paymentPath === "AMEX") return AMEX_FOLDER;
  return paymentPath === "DIGITAL" ? DIGITAL_FOLDER : CASH_FOLDER;
}

/** Build the sealed proofs ZIP. fflate uses a single compression level; we use
 *  level 0 (store) so the bulk JPEG/PDF bytes aren't recompressed (wasted CPU,
 *  ~0 size gain). The index files are tiny, so storing them uncompressed is
 *  negligible. UTF-8 entry names: fflate sets the UTF-8 general-purpose bit for
 *  non-ASCII paths, so the Japanese names open correctly in Windows Explorer.
 *
 *  `summaryCsv` is the SAME bytes as the standalone summary artifact (BOM+CRLF),
 *  embedded as 集計.csv so the accountant who only opens the ZIP still gets the
 *  cost breakdown. `attendeesCsv` is likewise the same bytes as the standalone
 *  attendees artifact, embedded as 参加者一覧.csv next to 集計.csv so the
 *  AttendeeIds column can be decoded into name/company/title without a second
 *  download. */
export function assembleProofsZip(
  month: string,
  entries: ProofZipEntry[],
  noticeInput: TransitionNoticeInput,
  summaryCsv: string,
  attendeesCsv: string,
  /** Reconciliation CSVs (review #2) — byte-identical copies of the standalone
   *  artifacts, embedded at ZIP root as AMEX{month}_Reconciliation.csv etc. so
   *  the ZIP alone is the complete accountant package (same doctrine as
   *  集計.csv / 参加者一覧.csv). Absent entries are skipped (e.g. no DIGITAL
   *  rows this month). */
  reconciliationCsvs?: { amex?: string | null; cash?: string | null; digital?: string | null },
): Uint8Array {
  const root = ROOT_PREFIX(month);
  const files: Record<string, Uint8Array> = {};
  // Per-folder dedupe so a (rare) filename collision gets a -2/-3 suffix.
  const seenPerFolder = new Map<string, Set<string>>();

  const encoder = new TextEncoder();

  for (const entry of entries) {
    const folder = folderFor(entry.paymentPath);
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
    files[`${root}${folder}${filename}`] = entry.bytes;
  }

  // 目次.csv retired (draft-round feedback 2026-07-18): the AMEX/CASH/DIGITAL
  // 照合CSVs' 領収書ファイル名 column IS the index now.
  files[`${root}集計.csv`] = encoder.encode(summaryCsv);
  files[`${root}参加者一覧.csv`] = encoder.encode(attendeesCsv);
  files[`${root}お知らせ.txt`] = encoder.encode(buildTransitionNotice(noticeInput));
  if (reconciliationCsvs?.amex) {
    files[`${root}AMEX${month}_Reconciliation.csv`] = encoder.encode(reconciliationCsvs.amex);
  }
  if (reconciliationCsvs?.cash) {
    files[`${root}CASH${month}_Reconciliation.csv`] = encoder.encode(reconciliationCsvs.cash);
  }
  if (reconciliationCsvs?.digital) {
    files[`${root}DIGITAL${month}_Reconciliation.csv`] = encoder.encode(reconciliationCsvs.digital);
  }

  return zipSync(files, { level: 0 });
}
