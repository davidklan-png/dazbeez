import { getCategoryByCode, requiresAttendees } from "@/lib/receipts/categories";
import {
  getFinalizedReconciliationForMonth,
  listAmexLineAttendeeNamesByMonth,
  listAmexLines,
  listAllReceiptsInMonth,
  listAttendeeNamesByReceiptIds,
  listReceiptRecordsByIds,
} from "@/lib/receipts/db";
import { getComplianceSettings } from "@/lib/receipts/settings";
import { summarizeOpenChecksForExport } from "@/lib/receipts/compliance";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { resolveLineCategory } from "@/lib/receipts/line-classification";
import type {
  AmexReconciliation,
  AmexStatementLine,
  ExportRow,
  ReceiptRecord,
} from "@/lib/receipts/types";
import { validateAmexLinesForSignoff } from "@/lib/receipts/reconciliation-signoff";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";

/**
 * Single source of truth for "what ships in this month's export bundle".
 *
 * After the 2026-07-08 redesign the export unit is the **statement month**,
 * not the transaction-date month: AMEX lines post over a ~6-week window
 * that lags the statement label, so filtering receipts by
 * `transaction_date LIKE 'YYYY-MM%'` produces a different population than
 * the AMEX validation set and the bundle is not self-consistent.
 *
 * The bundle closes that gap. Rows are assembled here, in one place, used
 * by both the export route (CSV/manifest) and the finalize validator.
 * Composition:
 *   - One row per AMEX statement line of month M (RowType=amex_line),
 *     with the matched receipt's fields joined when present.
 *     Missing-receipt and no-receipt lines appear with their reasons.
 *   - One row per CASH/DIGITAL receipt with transaction_date in month M
 *     (RowType=receipt). Transaction date is the accounting anchor for
 *     these — they have no statement.
 *   - A receipt matched to a line appears once (on the line row), never
 *     twice — even if its payment_path is CASH/DIGITAL and its
 *     transaction_date happens to fall in M.
 *   - payment_path='UNKNOWN' receipts are intentionally excluded: their
 *     export month is ambiguous. validateMonthReadyForExport blocks
 *     finalize when any are present.
 */
export interface ExportBundle {
  /** Bundle rows in CSV order: AMEX lines first (by transaction_date), then receipts. */
  rows: ExportRow[];
  /** Every receipt referenced by the bundle (matched-to-line + non-AMEX in-month). */
  receipts: ReceiptRecord[];
  /** Every AMEX statement line for the month. */
  amexLines: AmexStatementLine[];
  /** Attendees for every receipt in `receipts`, keyed by receipt id. */
  attendeeMap: Map<string, string[]>;
  /**
   * Per-row items to write into receipt_export_items at bundle-build time.
   * itemType 'receipt' covers BOTH matched-to-line and CASH/DIGITAL receipt
   * rows — the audit story is "what shipped", not "how it got there".
   */
  items: Array<{ itemType: "receipt"; itemId: string } | { itemType: "amex_line"; itemId: string }>;
}

export async function buildExportBundle(month: string): Promise<ExportBundle> {
  // (1) AMEX lines for the statement month. These are the spine of the
  // bundle — every line ships, with the matched receipt joined onto it.
  const amexLines = await listAmexLines(month);

  // (2) Receipts matched to those lines. Their transaction_date may sit in
  // a different month than the statement (late-March receipt on an April
  // statement) — that is the whole reason this redesign exists.
  const matchedReceiptIds = [
    ...new Set(
      amexLines
        .map((l) => l.matched_receipt_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const matchedReceipts = await listReceiptRecordsByIds(matchedReceiptIds);
  const matchedReceiptMap = new Map<string, ReceiptRecord>();
  for (const r of matchedReceipts) matchedReceiptMap.set(r.id, r);

  // (3) Non-AMEX receipts anchored by transaction_date in month M. UNKNOWN
  // is intentionally excluded here (ambiguous export month) — the
  // validator blocks finalize when any UNKNOWN receipts exist. Pages
  // internally via listAllReceiptsInMonth and refuses to silently
  // truncate at the cap (audit A6 — a partial bundle is an audit failure).
  const [cashReceipts, digitalReceipts] = await Promise.all([
    listAllReceiptsInMonth(month, { paymentPath: "CASH" }),
    listAllReceiptsInMonth(month, { paymentPath: "DIGITAL" }),
  ]);
  // A receipt matched to a line appears once on the line row — drop it
  // from the CASH/DIGITAL receipt-rows section so it cannot double-count.
  const nonAmexReceipts = [...cashReceipts, ...digitalReceipts].filter(
    (r) => !matchedReceiptMap.has(r.id),
  );

  // (4) Attendees for every receipt in one batched query (A6 kills N+1).
  const allReceipts = [...matchedReceipts, ...nonAmexReceipts];
  const allReceiptIds = allReceipts.map((r) => r.id);
  const attendeeMap = allReceiptIds.length > 0
    ? await listAttendeeNamesByReceiptIds(allReceiptIds)
    : new Map<string, string[]>();

  // (5) Assemble rows. AMEX-line rows first (in line order —
  // listAmexLines already sorts by transaction_date), then receipt rows.
  const rows: ExportRow[] = [];
  const items: ExportBundle["items"] = [];
  const seenReceiptIds = new Set<string>();

  for (const line of amexLines) {
    const receipt = line.matched_receipt_id
      ? matchedReceiptMap.get(line.matched_receipt_id)
      : undefined;
    const resolvedCategory = resolveLineCategory(line, receipt);
    const cat = getCategoryByCode(resolvedCategory ?? "");
    rows.push({
      rowType: "amex_line",
      lineId: line.id,
      matchStatus: line.match_status,
      receiptStatus: line.receipt_status,
      missingReceiptReason: line.receipt_missing_reason,
      cardholderName: line.cardholder_name,
      businessTripStatus: line.business_trip_status,
      receiptId: receipt?.id ?? line.matched_receipt_id ?? null,
      status: receipt?.status ?? null,
      originalR2Key: receipt?.original_r2_key ?? null,
      transactionDate: line.transaction_date,
      merchant: line.merchant,
      amountMinor: line.amount_minor,
      currency: line.currency,
      expenseType: receipt?.expense_type ?? null,
      expenseCategoryCode: resolvedCategory,
      expenseCategoryJa: cat?.jaName ?? null,
      expenseCategoryEn: cat?.enName ?? null,
      paymentPath: "AMEX",
      businessPurpose: receipt?.business_purpose ?? null,
      attendees: receipt?.id ? (attendeeMap.get(receipt.id) ?? []) : [],
      invoiceRegistrationNumber: receipt?.invoice_registration_number ?? null,
      qualifiedInvoiceStatus: receipt?.qualified_invoice_status ?? null,
      taxRate: receipt?.tax_rate ?? null,
      taxAmountMinor: receipt?.tax_amount_minor ?? null,
      sourceType: receipt?.source_type ?? null,
      counterpartyName: receipt?.counterparty_name ?? null,
    });
    items.push({ itemType: "amex_line", itemId: line.id });
    if (receipt?.id && !seenReceiptIds.has(receipt.id)) {
      items.push({ itemType: "receipt", itemId: receipt.id });
      seenReceiptIds.add(receipt.id);
    }
  }

  for (const receipt of nonAmexReceipts) {
    const cat = getCategoryByCode(receipt.expense_category_code ?? "");
    rows.push({
      rowType: "receipt",
      lineId: null,
      matchStatus: null,
      receiptStatus: null,
      missingReceiptReason: null,
      cardholderName: null,
      businessTripStatus: null,
      receiptId: receipt.id,
      status: receipt.status,
      originalR2Key: receipt.original_r2_key,
      transactionDate: receipt.transaction_date,
      merchant: receipt.merchant,
      amountMinor: receipt.amount_minor,
      currency: receipt.currency,
      expenseType: receipt.expense_type,
      expenseCategoryCode: receipt.expense_category_code ?? null,
      expenseCategoryJa: cat?.jaName ?? null,
      expenseCategoryEn: cat?.enName ?? null,
      paymentPath: receipt.payment_path,
      businessPurpose: receipt.business_purpose,
      attendees: attendeeMap.get(receipt.id) ?? [],
      invoiceRegistrationNumber: receipt.invoice_registration_number ?? null,
      qualifiedInvoiceStatus: receipt.qualified_invoice_status ?? null,
      taxRate: receipt.tax_rate ?? null,
      taxAmountMinor: receipt.tax_amount_minor ?? null,
      sourceType: receipt.source_type ?? null,
      counterpartyName: receipt.counterparty_name ?? null,
    });
    items.push({ itemType: "receipt", itemId: receipt.id });
  }

  return { rows, receipts: allReceipts, amexLines, attendeeMap, items };
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
 *   2. UNKNOWN payment_path gate: any UNKNOWN receipt with transaction_date
 *      in month M blocks finalize. The receipt's export month is ambiguous
 *      until the operator classifies it.
 *   3. Receipt-level checks on every CASH/DIGITAL receipt in scope (date,
 *      merchant, amount, category, attendees-where-required). These have
 *      no statement cross-check — receipt-level validation is their only
 *      gate (audit A4 #5).
 *   4. AMEX-line checks via validateAmexLinesForSignoff (category resolved
 *      from the matched receipt when present). AMEX-path receipts skip the
 *      receipt-level loop because the line checks cover them via the
 *      matched receipt's fields.
 *   5. Compliance engine gate (summarizeOpenChecksForMonth): any open
 *      `blocker`-severity check blocks; open `warning` checks block only
 *      when receipt_settings.export_block_on_warnings is true. That setting
 *      exists exactly to enforce this gate; if it is left false the warnings
 *      pass through as non-blocking.
 *   6. Cross-month match integrity (audit A7): a receipt matched to
 *      statement lines in more than one month blocks both months until
 *      resolved — overlapping windows make this possible.
 */
export async function validateMonthReadyForExport(
  month: string,
  prebuiltBundle?: ExportBundle,
  preloadedReconciliation?: AmexReconciliation | null,
): Promise<string[]> {
  const blockers: string[] = [];

  // (1) Statement-sealed gate. Callers that already fetched the
  // reconciliation (e.g. /api/receipts/export/month to populate the manifest
  // pointer) may pass it in to avoid a second D1 round-trip.
  const reconciliation =
    preloadedReconciliation !== undefined
      ? preloadedReconciliation
      : await getFinalizedReconciliationForMonth(month);
  if (!reconciliation) {
    blockers.push(
      `No finalized reconciliation for ${month}. Sign off the reconciliation first.`,
    );
  }

  // Build (or accept) the bundle. Build is expensive; callers that already
  // have one should pass it in.
  const bundle = prebuiltBundle ?? (await buildExportBundle(month));

  // (2) UNKNOWN payment_path gate. UNKNOWN receipts were excluded from the
  // bundle by design; their existence anywhere in the month is itself the
  // blocker. Query directly because the bundle intentionally doesn't carry them.
  const db = getReceiptsDb();
  const unknownResult = await db
    .prepare(
      `SELECT id, merchant FROM receipt_records
       WHERE deleted_at IS NULL
         AND payment_path = 'UNKNOWN'
         AND transaction_date LIKE ?`,
    )
    .bind(`${month}%`)
    .all<{ id: string; merchant: string | null }>();
  for (const row of unknownResult.results ?? []) {
    const label = row.merchant ?? row.id;
    blockers.push(
      `Receipt ${label}: payment_path is UNKNOWN — classify as AMEX, CASH, or DIGITAL before export`,
    );
  }

  // (2.5) Unreviewed-receipt gate. Mirrors computeExportBlockers' "Unreviewed
  // receipts" tile (status='needs_review' in-month, excluding pending
  // processing) so the tile's BLOCKER label is enforced at finalize —
  // previously the tile reported unreviewed receipts as blockers but the gate
  // never checked review status, so a month could read "blocked" on the tile
  // yet finalize successfully (reverse tile-vs-gate drift).
  //
  // Direct month-scoped query, NOT bundle.receipts: the tile counts receipts by
  // transaction_date in the statement month (all payment paths), while
  // bundle.receipts excludes in-month AMEX (validated via lines) and UNKNOWN
  // (excluded above) and includes cross-month matched receipts. Iterating the
  // bundle here would read a different set than the tile and re-open the drift.
  const unreviewedResult = await db
    .prepare(
      `SELECT * FROM receipt_records
       WHERE deleted_at IS NULL
         AND status = 'needs_review'
         AND transaction_date LIKE ?`,
    )
    .bind(`${month}%`)
    .all<ReceiptRecord>();
  for (const r of unreviewedResult.results ?? []) {
    // Same exclusion the tile applies: a needs_review receipt still in the
    // extraction queue is "pending processing", not "unreviewed" — it's
    // surfaced separately and fixed by draining the queue, not by reviewing.
    if (isPendingProcessing(r)) continue;
    const label = r.merchant ?? r.id;
    blockers.push(
      `Receipt ${label}: unreviewed (status='needs_review') — mark reviewed before exporting`,
    );
  }

  // (3) Receipt-level checks on CASH/DIGITAL receipts in the bundle.
  for (const receipt of bundle.receipts) {
    // AMEX-path receipts are validated via the line checks below; skip
    // them here to avoid double-gating.
    if (receipt.payment_path === "AMEX") continue;
    const label = receipt.merchant ?? receipt.id;
    if (!receipt.transaction_date) blockers.push(`Receipt ${receipt.id}: missing date`);
    if (!receipt.merchant) blockers.push(`Receipt ${receipt.id}: missing merchant`);
    if (receipt.amount_minor === null) blockers.push(`Receipt ${receipt.id}: missing amount`);
    if (!receipt.expense_category_code) {
      blockers.push(`Receipt ${receipt.id}: missing expense category`);
    }
    if (requiresAttendees(receipt.expense_category_code)) {
      const attendees = bundle.attendeeMap.get(receipt.id) ?? [];
      if (attendees.length === 0) blockers.push(`Receipt ${label}: requires attendees`);
    }
  }

  // (4) AMEX-line checks.
  const amexAttendees = await listAmexLineAttendeeNamesByMonth(month);
  const receiptMap = new Map<string, ReceiptRecord>();
  for (const r of bundle.receipts) receiptMap.set(r.id, r);
  blockers.push(
    ...validateAmexLinesForSignoff(
      bundle.amexLines,
      amexAttendees,
      bundle.attendeeMap,
      receiptMap,
    ),
  );

  // (5) Compliance-engine gate. Summarize over the month filter UNION the
  // bundle's receipt IDs: matched receipts may be dated outside the
  // statement month, and exported_month isn't stamped until after finalize,
  // so the month filter alone misses their open checks (Codex P1).
  const settings = await getComplianceSettings();
  const summary = await summarizeOpenChecksForExport(
    db,
    month,
    bundle.receipts.map((r) => r.id),
  );
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

  // (6) Cross-month match integrity (audit A7). A receipt matched to lines
  // in two different statement months is ambiguous — both months can't
  // ship the same receipt. Block both until disambiguated.
  const matchedLineMonths = await db
    .prepare(
      `SELECT DISTINCT asl.statement_month, asl.matched_receipt_id
       FROM amex_statement_lines asl
       WHERE asl.matched_receipt_id IS NOT NULL
         AND asl.statement_month IN (
           SELECT DISTINCT asl2.statement_month
           FROM amex_statement_lines asl2
           WHERE asl2.matched_receipt_id = asl.matched_receipt_id
         )`,
    )
    .all<{ statement_month: string; matched_receipt_id: string }>();
  // Group by receipt_id, find any referenced from >1 distinct month.
  // (The query returns one row per (month, receipt) pair; the same receipt
  // appearing under two months yields two rows we can collapse.)
  const monthsByReceipt = new Map<string, Set<string>>();
  for (const row of matchedLineMonths.results ?? []) {
    let set = monthsByReceipt.get(row.matched_receipt_id);
    if (!set) {
      set = new Set();
      monthsByReceipt.set(row.matched_receipt_id, set);
    }
    set.add(row.statement_month);
  }
  // Only block when one of the implicated months is the one we're finalizing.
  for (const [receiptId, months] of monthsByReceipt) {
    if (months.size > 1 && months.has(month)) {
      const others = [...months].filter((m) => m !== month).join(", ");
      blockers.push(
        `Receipt ${receiptId}: matched to AMEX lines in multiple statement months (${[...months].join(", ")}). Disambiguate before finalizing ${month} (other month(s): ${others}).`,
      );
    }
  }

  return blockers;
}

/**
 * Non-blocking warning emitted when finalizing month M while an earlier
 * month is still open. A late cash receipt for that earlier month will
 * cost a revision — operators should know that before clicking finalize.
 * Returns one warning string per earlier open month, or an empty array.
 *
 * "Open" = has unreconciled AMEX activity and no finalized export yet.
 */
export async function computeEarlierOpenMonthWarnings(
  month: string,
): Promise<string[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT DISTINCT asl.statement_month
       FROM amex_statement_lines asl
       LEFT JOIN receipt_exports re
         ON re.export_month = asl.statement_month
         AND re.status = 'finalized'
       WHERE asl.statement_month < ?
         AND re.id IS NULL
       ORDER BY asl.statement_month ASC`,
    )
    .bind(month)
    .all<{ statement_month: string }>();
  return (result.results ?? []).map((r) => {
    return `Earlier month ${r.statement_month} is still open — a late cash/digital receipt dated in that month will require an export revision once it lands.`;
  });
}
