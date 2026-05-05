import type { ExportRow } from "@/lib/receipts/types";

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
  return lines.join("\n");
}
