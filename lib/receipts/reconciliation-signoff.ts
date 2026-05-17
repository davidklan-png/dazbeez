import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const MANIFEST_HEADERS = [
  "line_id",
  "transaction_date",
  "merchant_amex",
  "merchant_receipt",
  "amount",
  "currency",
  "match_status",
  "receipt_status",
  "receipt_id",
  "receipt_sha256",
  "no_receipt_reason",
  "expense_category_code",
  "cardholder_name",
  "source_file_sha256",
  "attendees_amex",
  "attendees_receipt",
];

export function buildReconciliationManifestCsv(
  lines: AmexStatementLine[],
  receipts: ReceiptRecord[],
  amexAttendeeMap: Record<string, string[]>,
  receiptAttendeeMap: Record<string, string[]>,
): string {
  const receiptMap = new Map(receipts.map((r) => [r.id, r]));

  const rows: string[] = [MANIFEST_HEADERS.join(",")];

  for (const line of lines) {
    const receipt = line.matched_receipt_id
      ? receiptMap.get(line.matched_receipt_id)
      : null;

    const amount = line.currency === "JPY"
      ? String(line.amount_minor)
      : (line.amount_minor / 100).toFixed(2);

    const amexAtts = amexAttendeeMap[line.id] ?? [];
    const receiptAtts = receipt?.id
      ? (receiptAttendeeMap[receipt.id] ?? [])
      : [];

    rows.push(
      [
        csvEscape(line.id),
        csvEscape(line.transaction_date),
        csvEscape(line.merchant),
        csvEscape(receipt?.merchant),
        csvEscape(amount),
        csvEscape(line.currency),
        csvEscape(line.match_status),
        csvEscape(line.receipt_status),
        csvEscape(line.matched_receipt_id),
        csvEscape(receipt?.original_sha256),
        csvEscape(line.receipt_missing_reason),
        csvEscape(line.expense_category_code),
        csvEscape(line.cardholder_name),
        csvEscape(line.source_file_sha256),
        csvEscape(amexAtts.join("; ")),
        csvEscape(receiptAtts.join("; ")),
      ].join(","),
    );
  }

  return rows.join("\n");
}
