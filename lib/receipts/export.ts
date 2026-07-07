import type { ExportRow, ReceiptFile } from "@/lib/receipts/types";
import {
  ACCOUNTANT_DISCLAIMER_EN,
  ACCOUNTANT_DISCLAIMER_JA,
} from "@/lib/receipts/settings";

/**
 * CSV cell escaper.
 *
 * - Doubles inner double-quotes and wraps in quotes when the cell contains
 *   a comma, double-quote, newline, or carriage return.
 * - Formula injection guard (audit A5): if the first character is one of
 *   `=`, `+`, `-`, `@`, the cell is prefixed with a single quote so Excel
 *   / Sheets / Numbers treat it as text instead of evaluating it. The
 *   accountant opens this CSV in Excel on Windows; without the guard a
 *   merchant named `=cmd|'/c calc'!A1` would run a formula on open.
 */
function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Formula-injection guard. Single-quote prefix is invisible in Excel when
  // the cell format is General — the user sees the original text.
  if (s.length > 0 && (s[0] === "=" || s[0] === "+" || s[0] === "-" || s[0] === "@")) {
    s = `'${s}`;
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvQuoteAlways(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatAmount(amountMinor: number | null, currency: string): string {
  if (amountMinor === null) return "";
  if (currency === "JPY") return String(amountMinor);
  return (amountMinor / 100).toFixed(2);
}

const CSV_HEADERS = [
  "RowType",
  "TransactionDate",
  "Merchant",
  "Amount",
  "Currency",
  "PaymentPath",
  "ExpenseType",
  "ExpenseCategoryCode",
  "ExpenseCategoryJa",
  "ExpenseCategoryEn",
  "BusinessPurpose",
  "Attendees",
  // Line identity / status
  "LineId",
  "StatementMonth", // unused on receipt rows; populated from line when present
  "MatchStatus",
  "ReceiptStatus",
  "MissingReceiptReason",
  "CardholderName",
  "BusinessTripStatus",
  // Receipt identity
  "ReceiptId",
  "ReceiptStatus",
  "OriginalR2Key",
];

/**
 * Build the monthly export CSV body (no BOM, LF newlines). The route
 * prepends the UTF-8 BOM and converts to CRLF before upload so Excel on
 * Windows parses Japanese text correctly. Tests exercise this pure form.
 */
export function buildMonthlyExportCsv(
  rows: ExportRow[],
  attendeeMap: Map<string, string[]>,
): string {
  const lines: string[] = [CSV_HEADERS.join(",")];

  for (const row of rows) {
    const attendees = row.receiptId
      ? (attendeeMap.get(row.receiptId) ?? row.attendees ?? [])
      : (row.attendees ?? []);
    const line = [
      csvEscape(row.rowType),
      csvEscape(row.transactionDate),
      csvEscape(row.merchant),
      csvEscape(formatAmount(row.amountMinor, row.currency)),
      csvEscape(row.currency),
      csvEscape(row.paymentPath),
      csvEscape(row.expenseType),
      csvEscape(row.expenseCategoryCode),
      csvEscape(row.expenseCategoryJa),
      csvEscape(row.expenseCategoryEn),
      csvEscape(row.businessPurpose),
      csvQuoteAlways(attendees.join("; ")),
      csvEscape(row.lineId),
      // StatementMonth column is intentionally empty here; line.statement_month
      // matches the bundle's month so it's redundant on line rows and
      // meaningless on receipt rows.
      "",
      csvEscape(row.matchStatus),
      csvEscape(row.receiptStatus),
      csvEscape(row.missingReceiptReason),
      csvEscape(row.cardholderName),
      csvEscape(row.businessTripStatus),
      csvEscape(row.receiptId),
      csvEscape(row.status),
      csvEscape(row.originalR2Key),
    ].join(",");
    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * Add UTF-8 BOM (so Excel on Windows detects encoding and renders Japanese
 * text instead of mojibake) and convert LF → CRLF (Excel-friendlier).
 */
export function bomPrefixedCrlf(csvText: string): string {
  return `\ufeff${csvText.replace(/\r?\n/g, "\r\n")}`;
}

/**
 * Summary CSV: per-expense-category count + total, then a PaymentPath
 * breakdown, then a grand total. Generated from the same ExportRow list
 * as the main CSV so the two cannot drift.
 */
export function buildExportSummaryCsv(
  rows: ExportRow[],
  month: string,
  generatedAt: string,
): string {
  const catTotals = new Map<string, { count: number; totalMinor: number }>();
  let amexCount = 0;
  let amexTotal = 0;
  let cashCount = 0;
  let cashTotal = 0;
  let digitalCount = 0;
  let digitalTotal = 0;
  let grandCount = 0;
  let grandTotal = 0;

  for (const row of rows) {
    const code = row.expenseCategoryCode ?? "uncategorized";
    const cat = catTotals.get(code) ?? { count: 0, totalMinor: 0 };
    cat.count += 1;
    cat.totalMinor += row.amountMinor ?? 0;
    catTotals.set(code, cat);

    grandCount += 1;
    grandTotal += row.amountMinor ?? 0;

    if (row.rowType === "amex_line" || row.paymentPath === "AMEX") {
      amexCount += 1;
      amexTotal += row.amountMinor ?? 0;
    } else if (row.paymentPath === "CASH") {
      cashCount += 1;
      cashTotal += row.amountMinor ?? 0;
    } else if (row.paymentPath === "DIGITAL") {
      digitalCount += 1;
      digitalTotal += row.amountMinor ?? 0;
    }
  }

  const lines: string[] = [
    `Field,Value`,
    `Month,${csvEscape(month)}`,
    `GeneratedAt,${csvEscape(generatedAt)}`,
    `RowCount,${grandCount}`,
    `GrandTotalMinor,${grandTotal}`,
    ``,
    `ExpenseCategoryCode,Count,TotalMinor`,
  ];
  const sorted = [...catTotals.entries()].sort((a, b) => b[1].totalMinor - a[1].totalMinor);
  for (const [code, v] of sorted) {
    lines.push(`${csvEscape(code)},${v.count},${v.totalMinor}`);
  }
  lines.push(``);
  lines.push(`PaymentPath,Count,TotalMinor`);
  lines.push(`AMEX,${amexCount},${amexTotal}`);
  lines.push(`CASH,${cashCount},${cashTotal}`);
  lines.push(`DIGITAL,${digitalCount},${digitalTotal}`);
  return lines.join("\n");
}

export async function hashCsvContent(csvText: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(csvText);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildArchiveKey(month: string, exportId: string): string {
  return `exports/${month}/${exportId}-receipts.csv`;
}

export function buildManifestKey(month: string, exportId: string): string {
  return `exports/${month}/${exportId}-manifest.csv`;
}

export function buildManifestCsv(
  exportId: string,
  month: string,
  archiveKey: string,
  archiveSha256: string,
  rowCount: number,
  generatedAt: string,
  reconciliation?: {
    id: string;
    manifestR2Key: string;
    manifestSha256: string;
  } | null,
  options?: {
    files?: ReceiptFile[];
    amexArtifact?: { r2Key: string; sha256Hash: string; originalFilename: string } | null;
    exportRevision?: number;
    supersedesExportId?: string | null;
    correctionReason?: string | null;
  },
): string {
  const lines = [
    "Field,Value",
    `ExportId,${csvEscape(exportId)}`,
    `Month,${csvEscape(month)}`,
    `ArchiveKey,${csvEscape(archiveKey)}`,
    `SHA256,${csvEscape(archiveSha256)}`,
    `RowCount,${rowCount}`,
    `GeneratedAt,${csvEscape(generatedAt)}`,
  ];
  if (options?.exportRevision !== undefined) {
    lines.push(`ExportRevision,${options.exportRevision}`);
  }
  if (options?.supersedesExportId) {
    lines.push(`SupersedesExportId,${csvEscape(options.supersedesExportId)}`);
  }
  if (options?.correctionReason) {
    lines.push(`CorrectionReason,${csvEscape(options.correctionReason)}`);
  }
  if (reconciliation) {
    lines.push(
      `ReconciliationId,${csvEscape(reconciliation.id)}`,
      `ReconciliationManifestKey,${csvEscape(reconciliation.manifestR2Key)}`,
      `ReconciliationManifestSha256,${csvEscape(reconciliation.manifestSha256)}`,
    );
  }
  if (options?.amexArtifact) {
    lines.push(
      `AmexArtifactKey,${csvEscape(options.amexArtifact.r2Key)}`,
      `AmexArtifactSha256,${csvEscape(options.amexArtifact.sha256Hash)}`,
      `AmexArtifactFilename,${csvEscape(options.amexArtifact.originalFilename)}`,
    );
  }

  // Per-file hash table follows the metadata section.
  if (options?.files && options.files.length > 0) {
    lines.push("");
    lines.push("ObjectType,ObjectId,Role,R2Bucket,R2Key,OriginalFilename,ContentType,FileSizeBytes,SHA256,UploadedBy,UploadedAt");
    for (const f of options.files) {
      lines.push(
        [
          csvEscape(f.object_type),
          csvEscape(f.object_id),
          csvEscape(f.role),
          csvEscape(f.r2_bucket),
          csvEscape(f.r2_key),
          csvEscape(f.original_filename),
          csvEscape(f.content_type),
          String(f.file_size_bytes),
          csvEscape(f.sha256_hash),
          csvEscape(f.uploaded_by),
          csvEscape(f.uploaded_at),
        ].join(","),
      );
    }
  }

  return lines.join("\n");
}

export function buildReadmeKey(month: string, exportId: string): string {
  return `exports/${month}/${exportId}-README.txt`;
}

export function buildExportReadme(opts: {
  exportId: string;
  month: string;
  rowCount: number;
  generatedAt: string;
  exportRevision: number;
  supersedesExportId?: string | null;
  correctionReason?: string | null;
  archiveSha256: string;
  manifestSha256?: string | null;
}): string {
  const revisionLine =
    opts.exportRevision > 1
      ? `Revision: ${opts.exportRevision} (supersedes ${opts.supersedesExportId ?? "?"})\nCorrection reason: ${opts.correctionReason ?? ""}`
      : `Revision: 1 (initial)`;
  return [
    `Dazbeez monthly export — ${opts.month}`,
    `Export ID: ${opts.exportId}`,
    `Generated at: ${opts.generatedAt}`,
    `Row count: ${opts.rowCount}`,
    revisionLine,
    `Archive SHA-256: ${opts.archiveSha256}`,
    `Manifest SHA-256: ${opts.manifestSha256 ?? "(pending)"}`,
    "",
    "── Accountant review ──────────────────────────────────────",
    ACCOUNTANT_DISCLAIMER_EN,
    "",
    ACCOUNTANT_DISCLAIMER_JA,
    "",
    "── Files included ─────────────────────────────────────────",
    "See the manifest CSV for SHA-256 hashes of every receipt original,",
    "derivative, and the AMEX statement CSV included in this export.",
  ].join("\n");
}
