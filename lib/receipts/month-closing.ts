import { getCategoryByCode, requiresAttendees } from "@/lib/receipts/categories";
import {
  listAmexLineAttendeeNamesByMonth,
  listAmexLines,
  listAttendees,
  listReceiptRecords,
} from "@/lib/receipts/db";
import type { ExportRow, ReceiptRecord } from "@/lib/receipts/types";

export interface MonthlyExportDraft {
  receipts: ReceiptRecord[];
  attendeeMap: Map<string, string[]>;
  exportRows: ExportRow[];
}

export async function buildMonthlyExportDraft(
  month: string,
): Promise<MonthlyExportDraft> {
  const receipts = await listReceiptRecords({ month, limit: 1000 });
  const attendeeMap = new Map<string, string[]>();

  for (const receipt of receipts) {
    const attendees = await listAttendees(receipt.id);
    attendeeMap.set(receipt.id, attendees.map((a) => a.attendee_name));
  }

  const exportRows: ExportRow[] = receipts.map((receipt) => {
    const category = getCategoryByCode(receipt.expense_category_code ?? "");
    return {
      receiptId: receipt.id,
      transactionDate: receipt.transaction_date,
      merchant: receipt.merchant,
      amountMinor: receipt.amount_minor,
      currency: receipt.currency,
      expenseType: receipt.expense_type,
      expenseCategoryCode: receipt.expense_category_code ?? null,
      expenseCategoryJa: category?.jaName ?? null,
      expenseCategoryEn: category?.enName ?? null,
      paymentPath: receipt.payment_path,
      businessPurpose: receipt.business_purpose,
      attendees: attendeeMap.get(receipt.id) ?? [],
      status: receipt.status,
      originalR2Key: receipt.original_r2_key,
    };
  });

  return { receipts, attendeeMap, exportRows };
}

export async function validateMonthReadyForExport(
  month: string,
  draft?: MonthlyExportDraft,
): Promise<string[]> {
  const currentDraft = draft ?? (await buildMonthlyExportDraft(month));
  const blockers: string[] = [];

  for (const receipt of currentDraft.receipts) {
    const label = receipt.merchant ?? receipt.id;
    if (!receipt.transaction_date) blockers.push(`Receipt ${receipt.id}: missing date`);
    if (!receipt.merchant) blockers.push(`Receipt ${receipt.id}: missing merchant`);
    if (receipt.amount_minor === null) blockers.push(`Receipt ${receipt.id}: missing amount`);
    if (!receipt.expense_category_code) {
      blockers.push(`Receipt ${receipt.id}: missing expense category`);
    }
    if (requiresAttendees(receipt.expense_category_code)) {
      const attendees = currentDraft.attendeeMap.get(receipt.id) ?? [];
      if (attendees.length === 0) blockers.push(`Receipt ${label}: requires attendees`);
    }
  }

  const amexLines = await listAmexLines(month);
  const amexAttendees = await listAmexLineAttendeeNamesByMonth(month);
  for (const line of amexLines) {
    const label = `${line.transaction_date} ${line.merchant}`;
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
        ? currentDraft.attendeeMap.get(line.matched_receipt_id) ?? []
        : [];
      const directAmexAttendees = amexAttendees[line.id] ?? [];
      if (linkedReceiptAttendees.length === 0 && directAmexAttendees.length === 0) {
        blockers.push(
          `AMEX ${label}: ${getCategoryByCode(line.expense_category_code ?? "")?.jaName ?? line.expense_category_code} requires attendees`,
        );
      }
    }
    if (line.business_trip_status === "candidate") {
      blockers.push(`AMEX ${label}: unresolved business trip candidate`);
    }
  }

  return blockers;
}
