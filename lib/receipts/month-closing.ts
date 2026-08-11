import { getCategoryByCode, requiresAttendees } from "@/lib/receipts/categories";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";
import { resolveAttendeeNames } from "@/lib/receipts/attendee-directory";
import {
  getExport,
  getFinalizedReconciliationForMonth,
  listAmexLineAttendeeNamesByMonth,
  listAmexLines,
  listAttendeeDirectory,
  listAttendeeNamesByReceiptIds,
  listReceiptRecordsByIds,
} from "@/lib/receipts/db";
import {
  listReceiptsByExportStatementMonth,
  listUnknownInScopeReceipts,
} from "@/lib/receipts/membership";
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
import { isUnreviewedReceipt, receiptsMissingProofFiles } from "@/lib/receipts/blockers";
import { countReceiptFilesByObjectIds } from "@/lib/receipts/files";

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
 *   - One row per CASH/DIGITAL receipt ASSIGNED to statement month M
 *     (RowType=receipt) — selected by export_statement_month. Under ADR 0008 a
 *     receipt's stored month is the CALENDAR month of its transaction_date
 *     (June 11 → 2026-06), so this set is the month's own cash/digital receipts.
 *   - A receipt matched to a line appears once (on the line row), never
 *     twice — even if its payment_path is CASH/DIGITAL and it is also
 *     assigned to M.
 *   - payment_path='UNKNOWN' receipts are intentionally excluded: their
 *     export month is ambiguous. validateMonthReadyForExport blocks
 *     finalize when any in-scope UNKNOWN receipt is present.
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
   * Attendee directory (migration 0022): the company/title lookup the receipts
   * CSV's `AttendeeIds` column joins against and the finalize gate resolves
   * attendee names against. Single load point — the route, the page preview,
   * and the validator all read it from here.
   */
  attendeeDirectory: ReceiptAttendeeDirectoryEntry[];
  /**
   * Attendee names attached directly to AMEX lines for the month, keyed by
   * line id. Moved out of `validateMonthReadyForExport` (its former private
   * `listAmexLineAttendeeNamesByMonth` call) into the bundle so the receipts
   * CSV builder can also see line-level attendees (the gap where line
   * attendees satisfied the gate but vanished from the CSV). The bundle is the
   * single row-assembly authority (audit A4).
   */
  amexAttendees: Record<string, string[]>;
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

  // (3) Non-AMEX receipts selected by STORED membership (ADR 0008 / was ADR
  // 0006 PR #2): export_statement_month = M. Under the calendar rule a receipt
  // is assigned to the calendar month of its transaction_date at capture /
  // first date-set (lib/receipts/membership.ts). UNKNOWN is intentionally
  // excluded — it has no assigned month and blocks finalize at gate 2 until
  // classified. Undated cash/digital receipts stay NULL (unassignable) and are
  // excluded here.
  const nonAmexReceipts = (await listReceiptsByExportStatementMonth(month)).filter(
    (r) => !matchedReceiptMap.has(r.id),
  );

  // (4) Attendees for every receipt in one batched query (A6 kills N+1).
  const allReceipts = [...matchedReceipts, ...nonAmexReceipts];
  const allReceiptIds = allReceipts.map((r) => r.id);
  const attendeeMap = allReceiptIds.length > 0
    ? await listAttendeeNamesByReceiptIds(allReceiptIds)
    : new Map<string, string[]>();

  // (4b) Attendee directory (migration 0022) + line-level attendees. Both feed
  // the CSV builder (AttendeeIds column / line-attendee fallback) and the
  // finalize gate (name resolution). Single load point — the route, the page
  // preview, and the validator all read them from the bundle.
  const [attendeeDirectory, amexAttendees] = await Promise.all([
    listAttendeeDirectory(),
    listAmexLineAttendeeNamesByMonth(month),
  ]);

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
      rawCsvLineNumber: line.raw_csv_line_number ?? null,
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
      rawCsvLineNumber: null,
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

  return { rows, receipts: allReceipts, amexLines, attendeeMap, attendeeDirectory, amexAttendees, items };
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
/** Inputs the export-finalize gate needs, fetched by the async wrapper. */
export interface ValidateMonthReadyInput {
  month: string;
  reconciliation: AmexReconciliation | null;
  bundle: ExportBundle;
  /** Gate 2: in-month UNKNOWN payment_path receipts (id + merchant). */
  unknownReceipts: { id: string; merchant: string | null }[];
  /** Gate 2.5: in-month needs_review receipts (raw; core applies the
   * isPendingProcessing exclusion to match the tile). */
  unreviewedReceipts: ReceiptRecord[];
  /** Gate 4: attendees keyed by AMEX line id. */
  amexAttendees: Record<string, string[]>;
  /** Gate 5: open compliance checks summary. */
  complianceSummary: { blockers: number; warnings: number };
  /** Gate 5: compliance settings. */
  complianceSettings: { export_block_on_warnings: boolean };
  /** Gate 6: raw (statement_month, matched_receipt_id) rows for cross-month
   * match integrity; core groups them. */
  crossMonthMatchedLines: { statement_month: string; matched_receipt_id: string }[];
  /** Gate 7: receipt_files row count per shipped receipt id (absent = 0). A
   *  shipped receipt with zero rows has no proof to include in the ZIP. */
  receiptFileCounts: Map<string, number>;
  /** E3 (gate 1.5): the open draft's build + operator-message timestamps. The
   *  preface is frozen into the sealed bytes at build time, so a message edited
   *  after the build makes the bundle stale. When operatorMessageUpdatedAt >
   *  bundleBuiltAt, emit `message_stale`. null/undefined when there is no draft
   *  or nothing is built yet — no staleness check (matches pre-E3 behaviour). */
  exportBuild?: { bundleBuiltAt: string | null; operatorMessageUpdatedAt: string | null } | null;
}

/**
 * A single finalize-gate blocker with a stable code and (optionally) an in-app
 * destination that clears it. {@link validateMonthReadyForExportCoreDetailed}
 * returns these; the original string[] contract
 * ({@link validateMonthReadyForExportCore}) projects them to `.message`. Tests
 * assert on `code`, never on prose. `href` is set only where a concrete in-app
 * remedy exists (gate 1 → Reconcile); for every other blocker it is undefined —
 * do not guess destinations. `message_stale` is reserved for the editable-preface
 * staleness gate (E3); it is in the union now so the review screen can type it.
 */
export interface ExportBlocker {
  code:
    | "reconciliation_not_finalized"
    | "payment_path_unknown"
    | "receipt_unreviewed"
    | "receipt_field_missing"
    | "attendees_required"
    | "attendee_unresolved"
    | "amex_line"
    | "compliance"
    | "cross_month"
    | "missing_proof_file"
    | "message_stale"
    | "message_not_reviewed";
  message: string;
  /** In-app destination that lets the operator clear this blocker. */
  href?: string;
}

/**
 * Pure synchronous core of the export-finalize gate — DETAILED variant. Same
 * gate logic and canonical order (1 → 2 → 2.5 → 3 → 4 → 5 → 6 → 7) as the
 * original string[] core, but each blocker carries a stable `code` and, for
 * gate 1, a link to Reconcile so the pre-finalize review renders it as an
 * actionable link instead of dead prose. The string[] core delegates here, so
 * there is exactly one rule implementation. Extracted verbatim from the former
 * inline body so the gate is unit-testable without D1 and so the tile (Task 3)
 * shares the exact same rule logic.
 */
export function validateMonthReadyForExportCoreDetailed(
  input: ValidateMonthReadyInput,
): ExportBlocker[] {
  const {
    month,
    reconciliation,
    bundle,
    unknownReceipts,
    unreviewedReceipts,
    amexAttendees,
    complianceSummary,
    complianceSettings,
    crossMonthMatchedLines,
    receiptFileCounts,
  } = input;
  const blockers: ExportBlocker[] = [];

  // (1) Statement-sealed gate. The integrity anchor: the pack asserts it
  // reconciles against a sealed statement. Downgrading would let a pack be
  // built against a statement that can still change underneath it; only the
  // presentation changes — it becomes a link to Reconcile (June review).
  if (!reconciliation) {
    blockers.push({
      code: "reconciliation_not_finalized",
      message: `No finalized reconciliation for ${month}. Sign off the reconciliation first.`,
      href: `/receipts/reconcile?month=${month}`,
    });
  }

  // (1.5) Message staleness (E3). The editable preface is frozen into the sealed
  // bytes at build time (buildPackNotice runs at rebuild; the notice is sealed
  // + hashed inside the proofs ZIP). Editing it afterwards makes the built
  // bundle stale — the bytes the operator previewed no longer match what
  // finalize would seal. Require a rebuild (which re-bakes the message) before
  // finalizing. ISO-8601 strings compare lexicographically in chronological order.
  // (operator_message_updated_at is no longer re-synced to bundle_built_at at
  // build — see recordExportBundle — but advancing bundle_built_at past the save
  // timestamp still clears this gate, so "rebuild after edit" works as before.)
  const build = input.exportBuild;
  if (
    build?.bundleBuiltAt &&
    build?.operatorMessageUpdatedAt &&
    build.operatorMessageUpdatedAt > build.bundleBuiltAt
  ) {
    blockers.push({
      code: "message_stale",
      message:
        "Message edited after the draft was built. Rebuild the draft before finalizing.",
      // The remedy (Rebuild draft) lives on the export page's TopBar, but this
      // blocker surfaces on the /review page — with no link the operator had to
      // hunt for it (the 2026-06 incident). Point at the export page so the
      // blocker reads as a route, not dead prose. (Backlog #24 concrete case.)
      href: `/receipts/export?month=${month}`,
    });
  }

  // (1.6) Message reviewed. The companion to E3 for the case E3 cannot see: the
  // operator never opened the preface at all. operator_message_updated_at is
  // written ONLY by an explicit decision (save text, or "no message this month"
  // which writes the timestamp with a NULL message) — recordExportBundle no
  // longer touches it. So a NULL timestamp on the open draft means no decision
  // was made, and finalizing would silently ship an empty 【今月のご連絡】 that
  // is indistinguishable from a deliberate "no message." Force the decision.
  // This is the server-side gate for the 2026-06 loss (the client dirty-block
  // catches an unsaved typed draft; this catches a field never opened).
  if (build && build.operatorMessageUpdatedAt === null) {
    blockers.push({
      code: "message_not_reviewed",
      message:
        "Decide the monthly message before finalizing: save a preface, or mark “no message this month”.",
    });
  }

  // (2) UNKNOWN payment_path gate.
  for (const row of unknownReceipts) {
    const label = row.merchant ?? row.id;
    blockers.push({
      code: "payment_path_unknown",
      message: `Receipt ${label}: payment_path is UNKNOWN — classify as AMEX, CASH, or DIGITAL before export`,
    });
  }

  // (2.5) Unreviewed-receipt gate. isPendingProcessing exclusion matches the
  // tile (a needs_review receipt still in the queue is "pending processing",
  // not "unreviewed"). Direct month-scoped set, NOT bundle.receipts — see the
  // tile-vs-gate drift note in the former inline body (PR #73).
  for (const r of unreviewedReceipts) {
    if (!isUnreviewedReceipt(r)) continue;
    const label = r.merchant ?? r.id;
    blockers.push({
      code: "receipt_unreviewed",
      message: `Receipt ${label}: unreviewed (status='needs_review') — mark reviewed before exporting`,
    });
  }

  // (3) Receipt-level checks on CASH/DIGITAL receipts in the bundle.
  for (const receipt of bundle.receipts) {
    if (receipt.payment_path === "AMEX") continue;
    const label = receipt.merchant ?? receipt.id;
    if (!receipt.transaction_date) {
      blockers.push({ code: "receipt_field_missing", message: `Receipt ${receipt.id}: missing date` });
    }
    if (!receipt.merchant) {
      blockers.push({ code: "receipt_field_missing", message: `Receipt ${receipt.id}: missing merchant` });
    }
    if (receipt.amount_minor === null) {
      blockers.push({ code: "receipt_field_missing", message: `Receipt ${receipt.id}: missing amount` });
    }
    if (!receipt.expense_category_code) {
      blockers.push({
        code: "receipt_field_missing",
        message: `Receipt ${receipt.id}: missing expense category`,
      });
    }
    if (requiresAttendees(receipt.expense_category_code)) {
      const attendees = bundle.attendeeMap.get(receipt.id) ?? [];
      if (attendees.length === 0) {
        blockers.push({ code: "attendees_required", message: `Receipt ${label}: requires attendees` });
      } else {
        // Attendees present → every name must resolve to a directory entry
        // (company/title). Unresolved names block finalize (business-manager
        // review: every 会議費/接待交際費 attendee must show company + title).
        const { unresolved } = resolveAttendeeNames(attendees, bundle.attendeeDirectory);
        for (const name of unresolved) {
          blockers.push({
            code: "attendee_unresolved",
            message: `Receipt ${label}: attendee "${name}" is not registered in the attendee directory (company/title required)`,
          });
        }
      }
    }
  }

  // (4) AMEX-line checks. validateAmexLinesForSignoff returns prose strings;
  // each is tagged with the gate-level code `amex_line`.
  const receiptMap = new Map<string, ReceiptRecord>();
  for (const r of bundle.receipts) receiptMap.set(r.id, r);
  for (const message of validateAmexLinesForSignoff(
    bundle.amexLines,
    amexAttendees,
    bundle.attendeeMap,
    receiptMap,
    bundle.attendeeDirectory,
  )) {
    blockers.push({ code: "amex_line", message });
  }

  // (5) Compliance-engine gate.
  if (complianceSummary.blockers > 0) {
    blockers.push({
      code: "compliance",
      message: `${complianceSummary.blockers} open compliance blocker(s) on receipts in ${month}`,
    });
  }
  if (complianceSettings.export_block_on_warnings && complianceSummary.warnings > 0) {
    blockers.push({
      code: "compliance",
      message: `${complianceSummary.warnings} open compliance warning(s) in ${month} (export_block_on_warnings=true)`,
    });
  }

  // (6) Cross-month match integrity (audit A7). A receipt matched to lines in
  // two different statement months is ambiguous — both months can't ship it.
  const monthsByReceipt = new Map<string, Set<string>>();
  for (const row of crossMonthMatchedLines) {
    let set = monthsByReceipt.get(row.matched_receipt_id);
    if (!set) {
      set = new Set();
      monthsByReceipt.set(row.matched_receipt_id, set);
    }
    set.add(row.statement_month);
  }
  for (const [receiptId, months] of monthsByReceipt) {
    if (months.size > 1 && months.has(month)) {
      const others = [...months].filter((m) => m !== month).join(", ");
      blockers.push({
        code: "cross_month",
        message: `Receipt ${receiptId}: matched to AMEX lines in multiple statement months (${[...months].join(", ")}). Disambiguate before finalizing ${month} (other month(s): ${others}).`,
      });
    }
  }

  // (7) Proofs: a shipped receipt with zero receipt_files rows has no proof to
  // include in the ZIP. Shared predicate with the tile (receiptsMissingProofFiles).
  // D1-only — R2 existence is the rebuild's layer-2 check, not the gate's.
  // Missing proof_copy is NOT a blocker (the ZIP falls back to the original).
  for (const receipt of receiptsMissingProofFiles(bundle.receipts, receiptFileCounts)) {
    const label = receipt.merchant ?? receipt.id;
    blockers.push({
      code: "missing_proof_file",
      message: `Receipt ${label}: no proof file on record (no original or proof_copy) — cannot build the proofs bundle`,
    });
  }

  return blockers;
}

/**
 * Pure synchronous core — ORIGINAL string[] contract, kept for every existing
 * caller (API routes, finalize-card, backfill script, tests). Now a thin
 * projection over {@link validateMonthReadyForExportCoreDetailed} so there is
 * exactly one rule implementation; the messages are byte-identical to the
 * former inline body.
 */
export function validateMonthReadyForExportCore(
  input: ValidateMonthReadyInput,
): string[] {
  return validateMonthReadyForExportCoreDetailed(input).map((b) => b.message);
}

export async function validateMonthReadyForExportDetailed(
  month: string,
  prebuiltBundle?: ExportBundle,
  preloadedReconciliation?: AmexReconciliation | null,
): Promise<ExportBlocker[]> {
  // (1) Statement-sealed gate. Callers that already fetched the reconciliation
  // (e.g. /api/receipts/export/month to populate the manifest pointer) may
  // pass it in to avoid a second D1 round-trip.
  const reconciliation =
    preloadedReconciliation !== undefined
      ? preloadedReconciliation
      : await getFinalizedReconciliationForMonth(month);

  // Build (or accept) the bundle. Build is expensive; callers that already
  // have one should pass it in.
  const bundle = prebuiltBundle ?? (await buildExportBundle(month));
  const db = getReceiptsDb();

  // ADR 0008 (was ADR 0006 PR #2): gate scope is membership, not a raw
  // transaction_date LIKE filter. CASH/DIGITAL in scope = assigned to M (already
  // in bundle.receipts, alongside matched AMEX). UNKNOWN has no stored month, so
  // its scope is computed via listUnknownInScopeReceipts: an UNKNOWN receipt
  // blocks M only if its transaction_date's CALENDAR month is M.
  const unknownInScope = await listUnknownInScopeReceipts(month);

  // (2) UNKNOWN payment_path — only those in M's natural window.
  const unknownReceipts = unknownInScope.map((r) => ({
    id: r.id,
    merchant: r.merchant,
  }));

  // (2.5) Unreviewed receipts in scope for M = the bundle (matched AMEX +
  // CASH/DIGITAL assigned to M) ∪ UNKNOWN in M's calendar month. This supersedes
  // PR #73's calendar-scoped (`transaction_date LIKE month%`) query: now that
  // ADR 0008 defines shipping membership, scoping the unreviewed gate by the
  // bundle keeps gate ⇄ bundle consistent. Core applies isUnreviewedReceipt
  // (pending-exclusion) to each.
  const unreviewedReceipts = [...bundle.receipts, ...unknownInScope];

  // (4) AMEX-line attendees — sourced from the bundle (buildExportBundle loads
  // them once). The validator input field stays; it now reflects the bundle so
  // the route, the page preview, and the validator share one row-assembly
  // authority (audit A4).
  const amexAttendees = bundle.amexAttendees;

  // (5) Compliance — month filter UNION bundle receipt IDs (matched receipts
  // may be dated outside the statement month; Codex P1).
  const settings = await getComplianceSettings();
  const summary = await summarizeOpenChecksForExport(
    db,
    month,
    bundle.receipts.map((r) => r.id),
  );

  // (6) Cross-month match integrity.
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

  // (7) Proofs — count receipt_files rows per shipped receipt (D1; no R2 in the
  // gate — the rebuild's layer-2 check handles R2 existence).
  const receiptFileCounts = await countReceiptFilesByObjectIds(
    db,
    bundle.receipts.map((r) => r.id),
  );

  // (1.5) Message staleness (E3): the open draft's build vs operator-message
  // timestamps. getExport returns the current row (draft iff one is open).
  const exportRecord = await getExport(month);
  const exportBuild = exportRecord
    ? {
        bundleBuiltAt: exportRecord.bundle_built_at ?? null,
        operatorMessageUpdatedAt: exportRecord.operator_message_updated_at ?? null,
      }
    : null;

  return validateMonthReadyForExportCoreDetailed({
    month,
    reconciliation,
    bundle,
    unknownReceipts,
    unreviewedReceipts,
    amexAttendees,
    complianceSummary: summary,
    complianceSettings: settings,
    crossMonthMatchedLines: matchedLineMonths.results ?? [],
    receiptFileCounts,
    exportBuild,
  });
}

/**
 * Async wrapper — ORIGINAL string[] contract, kept for every existing caller.
 * Now a thin projection over {@link validateMonthReadyForExportDetailed} so the
 * fetch logic lives in one place; the messages are byte-identical to before.
 */
export async function validateMonthReadyForExport(
  month: string,
  prebuiltBundle?: ExportBundle,
  preloadedReconciliation?: AmexReconciliation | null,
): Promise<string[]> {
  return (await validateMonthReadyForExportDetailed(
    month,
    prebuiltBundle,
    preloadedReconciliation,
  )).map((b) => b.message);
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
