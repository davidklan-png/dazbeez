import type { AmexStatementLine, ReceiptRecord } from "@/lib/receipts/types";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";
import { resolveAttendeeNames } from "@/lib/receipts/attendee-directory";
import { requiresAttendees } from "@/lib/receipts/categories";
import { resolveLineCategory } from "@/lib/receipts/line-classification";
import { isUncategorizedLine } from "@/lib/receipts/blockers";

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
  "invoice_registration_number",
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
        // Manifest category column = resolved value (receipt when matched,
        // line otherwise). Column layout is unchanged.
        csvEscape(resolveLineCategory(line, receipt)),
        csvEscape(line.cardholder_name),
        csvEscape(line.source_file_sha256),
        csvEscape(amexAtts.join("; ")),
        csvEscape(receiptAtts.join("; ")),
        csvEscape(line.business_trip_status),
        csvEscape(line.business_trip_id),
        csvEscape(String(line.re_review_needed)),
        // 適格請求書 registration number (T-number) from the linked receipt;
        // empty when no receipt is linked or the receipt carries none.
        csvEscape(receipt?.invoice_registration_number),
      ].join(","),
    );
  }

  return rows.join("\n");
}

/**
 * Validate that all AMEX lines are ready for sign-off/export.
 * Returns an array of human-readable blocker strings (empty = ready).
 *
 * `receiptMap` carries the matched receipts so category can be resolved
 * from the receipt (not the line) when a match exists. Callers must build
 * it from the matched_receipt_id set of the lines being validated.
 *
 * `attendeeDirectory` (5th param, migration 0022): when a line's resolved
 * category requires attendees AND attendees are present, every attendee name
 * (the union of the linked receipt's attendees + the line's direct attendees)
 * must resolve to a directory entry — a name with no company/title on file is
 * a blocker (business-manager review requirement: every 会議費/接待交際費 attendee
 * must show company + title). Directory rows enforce company/title NOT NULL, so
 * resolution alone proves completeness.
 */
export function validateAmexLinesForSignoff(
  amexLines: AmexStatementLine[],
  amexAttendees: Record<string, string[]>,
  receiptAttendeeMap: Map<string, string[]>,
  receiptMap: Map<string, ReceiptRecord>,
  attendeeDirectory: ReceiptAttendeeDirectoryEntry[],
): string[] {
  const blockers: string[] = [];

  for (const line of amexLines) {
    const label = `${line.transaction_date} ${line.merchant}`;
    const receipt = line.matched_receipt_id
      ? receiptMap.get(line.matched_receipt_id)
      : undefined;
    const resolvedCategory = resolveLineCategory(line, receipt);

    if (line.match_status === "unmatched" || line.match_status === "matched") {
      blockers.push(`AMEX ${label}: unresolved match status (${line.match_status})`);
    }
    if (isUncategorizedLine(line, receipt)) {
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
    if (requiresAttendees(resolvedCategory)) {
      const linkedReceiptAttendees = line.matched_receipt_id
        ? receiptAttendeeMap.get(line.matched_receipt_id) ?? []
        : [];
      const directAmexAttendees = amexAttendees[line.id] ?? [];
      const names = [...linkedReceiptAttendees, ...directAmexAttendees];
      if (names.length === 0) {
        blockers.push(`AMEX ${label}: requires attendees`);
      } else {
        // Attendees present → every name must resolve to a directory entry
        // (company/title). Unresolved names block finalize.
        const { unresolved } = resolveAttendeeNames(names, attendeeDirectory);
        for (const name of unresolved) {
          blockers.push(
            `AMEX ${label}: attendee "${name}" is not registered in the attendee directory (company/title required)`,
          );
        }
      }
    }
    if (line.business_trip_status === "candidate") {
      blockers.push(`AMEX ${label}: unresolved business trip candidate`);
    }
    if (line.re_review_needed) {
      blockers.push(`AMEX ${label}: statement line changed after confirmation`);
    }
  }

  // Consolidated receipts: when ≥2 confirmed lines share one receipt, their
  // amounts must sum exactly to the receipt total. Partial groups are legal
  // during the month; finalize is where the books must balance. (Single-line
  // amount mismatches remain allowed, as before — "Amount differs — verify
  // before confirming" is a reviewer judgment, not a blocker.)
  const confirmedByReceipt = new Map<string, AmexStatementLine[]>();
  for (const line of amexLines) {
    if (line.match_status !== "confirmed" || !line.matched_receipt_id) continue;
    const group = confirmedByReceipt.get(line.matched_receipt_id) ?? [];
    group.push(line);
    confirmedByReceipt.set(line.matched_receipt_id, group);
  }
  for (const [receiptId, group] of confirmedByReceipt) {
    if (group.length < 2) continue;
    const receipt = receiptMap.get(receiptId);
    if (!receipt || receipt.amount_minor === null) continue;
    const sum = group.reduce((total, line) => total + line.amount_minor, 0);
    if (sum !== receipt.amount_minor) {
      const label = receipt.merchant ?? receiptId;
      blockers.push(
        `Consolidated receipt ${label}: ${group.length} confirmed lines sum to ${sum} but receipt total is ${receipt.amount_minor}`,
      );
    }
  }

  return blockers;
}
