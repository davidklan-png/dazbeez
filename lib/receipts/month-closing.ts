import { getCategoryByCode, requiresAttendees } from "@/lib/receipts/categories";
import {
  getFinalizedReconciliationForMonth,
  listAmexLineAttendeeNamesByMonth,
  listAmexLines,
  listAttendees,
  listReceiptRecords,
  listReceiptRecordsByIds,
} from "@/lib/receipts/db";
import { getComplianceSettings } from "@/lib/receipts/settings";
import { summarizeOpenChecksForMonth } from "@/lib/receipts/compliance";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import type { ExportRow, ReceiptRecord } from "@/lib/receipts/types";
import { validateAmexLinesForSignoff } from "@/lib/receipts/reconciliation-signoff";

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

/**
 * Single enforcement authority for export finalize. Every finalize path
 * (POST /api/receipts/export/month, POST /api/receipts/export/[month]) MUST
 * route through here — UI tiles in lib/receipts/blockers.ts are
 * presentation-only and do not gate the API.
 *
 * Returns an array of human-readable blocker strings (empty = ready).
 * Composition (in order):
 *   1. Statement-sealed gate: a finalized reconciliation must exist for the
 *      month. (No reconciliation ⇒ cannot finalize an export.)
 *   2. Receipt-level checks on every receipt in scope (date, merchant,
 *      amount, category, attendees-where-required).
 *   3. AMEX-line checks via validateAmexLinesForSignoff (category resolved
 *      from the matched receipt when present).
 *   4. Compliance engine gate (summarizeOpenChecksForMonth): any open
 *      `blocker`-severity check blocks; open `warning` checks block only
 *      when receipt_settings.export_block_on_warnings is true. That setting
 *      exists exactly to enforce this gate; if it is left false the warnings
 *      pass through as non-blocking.
 */
export async function validateMonthReadyForExport(
  month: string,
  draft?: MonthlyExportDraft,
): Promise<string[]> {
  const blockers: string[] = [];

  // (1) Statement-sealed gate.
  const reconciliation = await getFinalizedReconciliationForMonth(month);
  if (!reconciliation) {
    blockers.push(
      `No finalized reconciliation for ${month}. Sign off the reconciliation first.`,
    );
  }

  // (2) Receipt-level checks.
  const currentDraft = draft ?? (await buildMonthlyExportDraft(month));
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

  // (3) AMEX-line checks (resolves category from the matched receipt when
  // present). Includes both month receipts and matched-but-out-of-month
  // receipts in the receiptMap — e.g. a late-March receipt linked to an
  // April statement line.
  const amexLines = await listAmexLines(month);
  const amexAttendees = await listAmexLineAttendeeNamesByMonth(month);
  const matchedReceiptIds = amexLines
    .map((line) => line.matched_receipt_id)
    .filter((id): id is string => Boolean(id));
  const missingMatchedIds = matchedReceiptIds.filter(
    (id) => !currentDraft.attendeeMap.has(id),
  );
  const matchedReceipts = await listReceiptRecordsByIds(missingMatchedIds);
  for (const receipt of matchedReceipts) {
    const attendees = await listAttendees(receipt.id);
    currentDraft.attendeeMap.set(
      receipt.id,
      attendees.map((a) => a.attendee_name),
    );
  }
  const receiptMap = new Map<string, ReceiptRecord>();
  for (const r of currentDraft.receipts) receiptMap.set(r.id, r);
  for (const r of matchedReceipts) receiptMap.set(r.id, r);

  blockers.push(
    ...validateAmexLinesForSignoff(amexLines, amexAttendees, currentDraft.attendeeMap, receiptMap),
  );

  // (4) Compliance-engine gate.
  const db = getReceiptsDb();
  const settings = await getComplianceSettings();
  const summary = await summarizeOpenChecksForMonth(db, month);
  if (summary.blockers > 0) {
    blockers.push(
      `${summary.blockers} open compliance blocker(s) on receipts in ${month}`,
    );
  }
  if (settings.export_block_on_warnings && summary.warnings > 0) {
    blockers.push(
      `${summary.warnings} open compliance warning(s) in ${month} (export_block_on_warnings=true)`,
    );
  }

  return blockers;
}
