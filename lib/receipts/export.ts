import type { ExportRow, ReceiptFile } from "@/lib/receipts/types";
import {
  ACCOUNTANT_DISCLAIMER_EN,
  ACCOUNTANT_DISCLAIMER_JA,
} from "@/lib/receipts/settings";

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
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
  "ReceiptId",
  "TransactionDate",
  "Merchant",
  "Amount",
  "Currency",
  "ExpenseType",
  "ExpenseCategoryCode",
  "ExpenseCategoryJa",
  "ExpenseCategoryEn",
  "PaymentPath",
  "BusinessPurpose",
  "Attendees",
  "Status",
  "R2Key",
];

export function buildMonthlyExportCsv(
  rows: ExportRow[],
  attendeeMap: Map<string, string[]>,
): string {
  const lines: string[] = [CSV_HEADERS.join(",")];

  for (const row of rows) {
    const attendees = attendeeMap.get(row.receiptId) ?? [];
    const line = [
      csvEscape(row.receiptId),
      csvEscape(row.transactionDate),
      csvEscape(row.merchant),
      csvEscape(formatAmount(row.amountMinor, row.currency)),
      csvEscape(row.currency),
      csvEscape(row.expenseType),
      csvEscape(row.expenseCategoryCode),
      csvEscape(row.expenseCategoryJa),
      csvEscape(row.expenseCategoryEn),
      csvEscape(row.paymentPath),
      csvEscape(row.businessPurpose),
      csvQuoteAlways(attendees.join("; ")),
      csvEscape(row.status),
      csvEscape(row.originalR2Key),
    ].join(",");
    lines.push(line);
  }

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
