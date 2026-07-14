// Proofs-ZIP builder for the accountant bundle (PR 2).
//
// Pure helpers that turn a month's shipped receipts + their resolved proof
// bytes into the sealed `exports/<month>/<exportId>-proofs.zip` artifact. All
// naming is Japanese (the accountant's working language) and ties each proof to
// a statement line via the `No` join column (the first column of the receipts
// CSV — see buildMonthlyExportCsv). The route does the R2 fetches and passes the
// bytes here; these helpers are unit-testable without R2/D1.
//
// Folder contract (matches the manual delivery the accountant already receives):
//   領収書等証憑_<month>/
//     AMEX明細分/            ← receipts matched to AMEX statement lines
//       No03_研究開発費_OpenAI_¥108,341.pdf
//     追加経費_現金デジタル分/ ← CASH/DIGITAL receipts (calendar-month membership)
//       No33_旅費交通費_セブン-イレブン東中野末広橋店_¥10,000.jpg
//     目次.csv               ← index
//     お知らせ.txt           ← transition notice (what changed vs manual delivery)

import { zipSync } from "fflate";

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

/** ¥-prefixed comma-grouped yen amount for filenames / 目次. JPY only (proofs
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

// ─── 目次.csv (index) ────────────────────────────────────────────────────────

export interface ProofMokuziRow {
  no: number;
  filename: string;
  transactionDate: string | null;
  merchant: string;
  amountMinor: number;
  currency: string;
  categoryJa: string;
  statementLineId: string | null;
  receiptId: string;
  sha256: string;
  source: "proof_copy" | "original";
}

function csvQuote(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** 目次.csv — one row per proof, Excel-safe (BOM + CRLF + quoted comma fields).
 *  `No` is the join key to the receipts CSV; `出典` is 原本 (original) when the
 *  proof_copy derivative was absent and we fell back to the original. */
export function buildProofsMokuziCsv(rows: ProofMokuziRow[]): string {
  const header = [
    "No",
    "ファイル名",
    "取引日",
    "店舗",
    "金額",
    "勘定科目",
    "statement_line_id",
    "receipt_id",
    "original_sha256",
    "出典",
  ].join(",");
  const body = rows
    .slice()
    .sort((a, b) => a.no - b.no)
    .map((r) =>
      [
        String(r.no),
        csvQuote(r.filename),
        csvQuote(r.transactionDate),
        csvQuote(r.merchant),
        csvQuote(formatYenAmount(r.amountMinor, r.currency)),
        csvQuote(r.categoryJa),
        csvQuote(r.statementLineId),
        csvQuote(r.receiptId),
        csvQuote(r.sha256),
        r.source === "original" ? "原本" : "圧縮コピー",
      ].join(","),
    );
  // BOM (Excel on Windows detects UTF-8 → Japanese renders) + CRLF.
  return `\uFEFF${[header, ...body].join("\r\n")}\r\n`;
}

// ─── お知らせ.txt (transition notice) ────────────────────────────────────────

export interface TransitionNoticeInput {
  monthLabel: string; // e.g. "2026年6月"
  rowCount: number; // receipts CSV rows (AMEX lines + cash/digital)
  receiptCount: number; // distinct receipts with a proof in the zip
  /** AMEX statement lines shipped with no receipt, with the recorded reason. */
  missingReceiptLines: { lineId: string; reason: string }[];
  /** IC-card top-up advisories (non-blocking) among the proofs, if any. */
  icAdvisories: { no: number; merchant: string; amountMinor: number }[];
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
    "・各証憑のファイル名先頭にある NoXX は、明細CSVの No 列と対応しています（従来の①②等の丸数字に代わる整理番号です）。",
  );
  lines.push(
    "・接待・会議の出席者は別紙PDFではなく、明細CSVの 出席者 列に記載しています。",
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
      lines.push(`・No/明細 ${m.lineId}: ${m.reason || "（理由記録なし）"}`);
    }
  }
  if (input.icAdvisories.length > 0) {
    lines.push("");
    lines.push(
      "【ICカードチャージの可能性がある取引（参考・確定ではありません）】",
    );
    for (const ic of input.icAdvisories) {
      lines.push(
        `・No${String(ic.no).padStart(2, "0")} ${ic.merchant} ¥${ic.amountMinor.toLocaleString("ja-JP")} — 交通系ICカードのチャージの可能性があります。業務利用の確定・精算方法は会計判断をお願いします。`,
      );
    }
  }
  if (input.exportRevision > 1) {
    lines.push("");
    lines.push("【改訂情報】");
    lines.push(`・改訹: ${input.exportRevision}（差替元: ${input.supersedesExportId ?? "不明"}）`);
    lines.push(`・改訂理由: ${input.correctionReason ?? "（記録なし）"}`);
  }
  lines.push("");
  lines.push("ご不明な点があればお知らせください。");
  return lines.join("\r\n");
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
  source: "proof_copy" | "original";
  bytes: Uint8Array;
  transactionDate: string | null;
  receiptId: string;
  statementLineId: string | null;
  sha256: string;
  paymentPath: ProofPaymentPath;
}

const ROOT_PREFIX = (month: string) => `領収書等証憓_${month}/`;
const AMEX_FOLDER = "AMEX明細分/";
const CASH_FOLDER = "追加経費_現金デジタル分/";

function folderFor(paymentPath: ProofPaymentPath): string {
  return paymentPath === "AMEX" ? AMEX_FOLDER : CASH_FOLDER;
}

/** Build the sealed proofs ZIP. fflate uses a single compression level; we use
 *  level 0 (store) so the bulk JPEG/PDF bytes aren't recompressed (wasted CPU,
 *  ~0 size gain). The two index files are tiny, so storing them uncompressed is
 *  negligible. UTF-8 entry names: fflate sets the UTF-8 general-purpose bit for
 *  non-ASCII paths, so the Japanese names open correctly in Windows Explorer. */
export function assembleProofsZip(
  month: string,
  entries: ProofZipEntry[],
  noticeInput: TransitionNoticeInput,
): Uint8Array {
  const root = ROOT_PREFIX(month);
  const files: Record<string, Uint8Array> = {};
  const mokuziRows: ProofMokuziRow[] = [];
  // Per-folder dedupe so a (rare) filename collision gets a -2/-3 suffix.
  const seenPerFolder = new Map<string, Set<string>>();

  const encoder = new TextEncoder();

  for (const entry of entries) {
    const folder = folderFor(entry.paymentPath);
    const base = buildProofFilename({
      no: entry.no,
      categoryJa: entry.categoryJa,
      merchant: entry.merchant,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      ext: entry.ext,
    });
    let filename = base;
    let fileIndex = 1;
    const seen = seenPerFolder.get(folder) ?? new Set<string>();
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
    seen.add(filename);
    seenPerFolder.set(folder, seen);
    files[`${root}${folder}${filename}`] = entry.bytes;
    mokuziRows.push({
      no: entry.no,
      filename,
      transactionDate: entry.transactionDate,
      merchant: entry.merchant,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      categoryJa: entry.categoryJa,
      statementLineId: entry.statementLineId,
      receiptId: entry.receiptId,
      sha256: entry.sha256,
      source: entry.source,
    });
  }

  files[`${root}目次.csv`] = encoder.encode(buildProofsMokuziCsv(mokuziRows));
  files[`${root}お知らせ.txt`] = encoder.encode(buildTransitionNotice(noticeInput));

  return zipSync(files, { level: 0 });
}
