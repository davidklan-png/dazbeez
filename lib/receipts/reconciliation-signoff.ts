import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";
import { requiresAttendees } from "@/lib/receipts/categories";

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
  "business_trip_status",
  "business_trip_id",
  "re_review_needed",
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
        csvEscape(line.business_trip_status),
        csvEscape(line.business_trip_id),
        csvEscape(String(line.re_review_needed)),
      ].join(","),
    );
  }

  return rows.join("\n");
}

/**
 * Validate that all AMEX lines are ready for sign-off/export.
 * Returns an array of human-readable blocker strings (empty = ready).
 */
export function validateAmexLinesForSignoff(
  amexLines: AmexStatementLine[],
  amexAttendees: Record<string, string[]>,
  receiptAttendeeMap: Map<string, string[]>,
): string[] {
  const blockers: string[] = [];

  for (const line of amexLines) {
    const label = `${line.transaction_date} ${line.merchant}`;

    if (line.match_status === "unmatched" || line.match_status === "matched") {
      blockers.push(`AMEX ${label}: unresolved match status (${line.match_status})`);
    }
    if (!line.expense_category_code) {
      blockers.push(`AMEX ${label}: missing expense category`);
    }
    if (
      line.receipt_status === "matched" &&
      (!line.matched_receipt_id || line.match_status !== "confirmed")
    ) {
      blockers.push(`AMEX ${label}: matched receipt is not confirmed`);
    }
    if (
      line.receipt_status === "missing_receipt" ||
      ((line.receipt_status === "no_receipt_required" ||
        line.receipt_status === "receipt_not_available") &&
        !line.receipt_missing_reason)
    ) {
      blockers.push(`AMEX ${label}: missing receipt requires a reason`);
    }
    if (requiresAttendees(line.expense_category_code)) {
      const linkedReceiptAttendees = line.matched_receipt_id
        ? receiptAttendeeMap.get(line.matched_receipt_id) ?? []
        : [];
      const directAmexAttendees = amexAttendees[line.id] ?? [];
      if (linkedReceiptAttendees.length === 0 && directAmexAttendees.length === 0) {
        blockers.push(`AMEX ${label}: requires attendees`);
      }
    }
    if (line.business_trip_status === "candidate") {
      blockers.push(`AMEX ${label}: unresolved business trip candidate`);
    }
    if (line.re_review_needed) {
      blockers.push(`AMEX ${label}: statement line changed after confirmation`);
    }
  }

  return blockers;
}
