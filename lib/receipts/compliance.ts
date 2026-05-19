// Compliance check engine. The pure `computeReceiptChecks` is exercised by
// tests; `runComplianceChecks` persists the engine output into
// `receipt_compliance_checks`, diffing against the prior row set so that
// fixes are reflected without an explicit "resolve" click.

import { requiresAttendees } from "@/lib/receipts/categories";
import { newUuid, nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { listFilesForObject } from "@/lib/receipts/files";
import { validateInvoiceRegistrationNumber } from "@/lib/receipts/invoice";
import type {
  ComplianceCheck,
  ComplianceCheckSeverity,
  ComplianceCheckType,
  ComplianceSettings,
  ComputedCheck,
  ReceiptAttendee,
  ReceiptFile,
  ReceiptRecord,
  SourceType,
} from "@/lib/receipts/types";

const ELECTRONIC_SOURCE_TYPES: ReadonlySet<SourceType> = new Set([
  "electronic_receipt",
  "digital_invoice",
  "email_attachment",
  "credit_card_statement",
  "amex_csv",
]);

const PAPER_SOURCE_TYPES: ReadonlySet<SourceType> = new Set([
  "paper_scanned",
]);

export interface ComputeReceiptChecksInput {
  receipt: ReceiptRecord;
  attendees: ReceiptAttendee[];
  files: ReceiptFile[];
  settings: ComplianceSettings;
}

/**
 * Pure check engine. No I/O. Returns the set of checks that *should* be
 * "open" for the given receipt. Tests exercise this function directly.
 */
export function computeReceiptChecks(
  input: ComputeReceiptChecksInput,
): ComputedCheck[] {
  const { receipt, attendees, files, settings } = input;
  const checks: ComputedCheck[] = [];

  if (!receipt.transaction_date) {
    checks.push({
      checkType: "missing_transaction_date",
      severity: "blocker",
      message: "Transaction date is missing.",
    });
  }

  if (receipt.amount_minor === null || receipt.amount_minor === undefined) {
    checks.push({
      checkType: "missing_amount",
      severity: "blocker",
      message: "Amount is missing.",
    });
  }

  const hasCounterparty =
    !!(receipt.counterparty_name && receipt.counterparty_name.trim()) ||
    !!(receipt.merchant && receipt.merchant.trim());
  if (!hasCounterparty) {
    checks.push({
      checkType: "missing_counterparty",
      severity: "warning",
      message: "Counterparty / merchant name is missing.",
    });
  }

  if (!receipt.expense_category_code) {
    checks.push({
      checkType: "missing_category",
      severity: "blocker",
      message: "Expense category is missing.",
    });
  }

  const originals = files.filter((f) => f.is_original === 1);
  if (originals.length === 0) {
    checks.push({
      checkType: "missing_receipt",
      severity: "blocker",
      message: "Original receipt file is missing.",
    });
  }

  // Attendees: required for meeting and entertainment expenses unless the
  // operator has disabled the requirement.
  const code = receipt.expense_category_code ?? "";
  const requiresAttendeesForCategory =
    (code === "meeting" && settings.require_attendees_for_meeting) ||
    (code === "entertainment" && settings.require_attendees_for_entertainment) ||
    requiresAttendees(code);
  if (requiresAttendeesForCategory && attendees.length === 0) {
    checks.push({
      checkType: "missing_attendees",
      severity: "blocker",
      message: "Attendees are required for this expense category.",
    });
  }

  // Qualified invoice (インボイス制度) checks
  const invoiceMode = settings.invoice_number_requirement_mode;
  if (invoiceMode !== "disabled") {
    const severity: ComplianceCheckSeverity =
      invoiceMode === "blocker" ? "blocker" : "warning";
    const number = receipt.invoice_registration_number;
    const validation = validateInvoiceRegistrationNumber(number);
    if (!number || number.trim() === "") {
      checks.push({
        checkType: "missing_invoice_registration_number",
        severity,
        message:
          "Qualified-invoice registration number (T+13 digits) is missing.",
      });
    } else if (validation.registrationStatus === "format_invalid") {
      checks.push({
        checkType: "invoice_registration_invalid",
        severity,
        message: validation.message ?? "Registration number format is invalid.",
        details: { number },
      });
    }
  }

  // Tax rate / consumption tax amount — warning only; some receipts
  // legitimately omit them (small-amount, non-taxable).
  if (!receipt.tax_rate) {
    checks.push({
      checkType: "missing_tax_rate",
      severity: "warning",
      message: "Tax rate is missing (typically 10% or 8% reduced).",
    });
  }
  if (
    receipt.tax_amount_minor === null ||
    receipt.tax_amount_minor === undefined
  ) {
    checks.push({
      checkType: "missing_tax_amount",
      severity: "warning",
      message: "Consumption tax amount is missing.",
    });
  }

  // Electronic transaction preservation: if the source type is electronic,
  // the original digital file (PDF / email / download) must be preserved.
  // We treat image-only originals as a screenshot proxy and warn.
  const sourceType = receipt.source_type as SourceType | null | undefined;
  if (sourceType && ELECTRONIC_SOURCE_TYPES.has(sourceType)) {
    const original = originals[0];
    const looksLikeScreenshot =
      !!original && original.content_type.startsWith("image/");
    if (looksLikeScreenshot) {
      checks.push({
        checkType: "electronic_transaction_missing_original",
        severity: "warning",
        message:
          "This appears to be an electronic transaction. Preserve the original PDF/email/download where available.",
      });
    }
  }

  // Scanner preservation metadata (paper scans)
  if (sourceType && PAPER_SOURCE_TYPES.has(sourceType)) {
    const original = originals[0];
    const missingMetadata =
      !original ||
      !original.sha256_hash ||
      !original.file_size_bytes ||
      !original.content_type;
    if (missingMetadata) {
      checks.push({
        checkType: "scanner_preservation_metadata_incomplete",
        severity: "warning",
        message:
          "Scanner preservation metadata (hash / size / content type) is incomplete.",
      });
    }
  }

  return checks;
}

/**
 * Persist the result of `computeReceiptChecks` to receipt_compliance_checks.
 *
 * Open checks that no longer apply are marked `resolved`. New checks insert
 * new rows. Existing open checks with the same `(object_type, object_id,
 * check_type)` are left untouched so their `checked_at` and `id` stay
 * stable across runs.
 */
export async function persistReceiptChecks(
  db: D1Database,
  receiptId: string,
  computed: ComputedCheck[],
): Promise<void> {
  const existing = await db
    .prepare(
      `SELECT id, check_type, status FROM receipt_compliance_checks
       WHERE object_type = 'receipt' AND object_id = ?`,
    )
    .bind(receiptId)
    .all<{ id: string; check_type: string; status: string }>();

  const existingOpen = new Map<string, { id: string }>();
  for (const row of existing.results ?? []) {
    if (row.status === "open") existingOpen.set(row.check_type, { id: row.id });
  }

  const wantedTypes = new Set(computed.map((c) => c.checkType));
  const now = nowIso();

  // Resolve previously-open checks that no longer apply.
  for (const [checkType, row] of existingOpen) {
    if (!wantedTypes.has(checkType as ComplianceCheckType)) {
      await db
        .prepare(
          `UPDATE receipt_compliance_checks
           SET status = 'resolved', resolved_at = ?, resolved_by = 'system'
           WHERE id = ?`,
        )
        .bind(now, row.id)
        .run();
    }
  }

  // Insert any newly-triggered checks.
  for (const check of computed) {
    if (existingOpen.has(check.checkType)) continue;
    await db
      .prepare(
        `INSERT INTO receipt_compliance_checks
          (id, object_type, object_id, check_type, status, severity, message,
           details_json, checked_at, created_at)
         VALUES (?, 'receipt', ?, ?, 'open', ?, ?, ?, ?, ?)`,
      )
      .bind(
        newUuid(),
        receiptId,
        check.checkType,
        check.severity,
        check.message,
        check.details ? stringifyJson(check.details) : null,
        now,
        now,
      )
      .run();
  }
}

export async function listChecksForObject(
  db: D1Database,
  objectType: string,
  objectId: string,
): Promise<ComplianceCheck[]> {
  const result = await db
    .prepare(
      `SELECT * FROM receipt_compliance_checks
       WHERE object_type = ? AND object_id = ?
       ORDER BY status ASC, severity DESC, checked_at DESC`,
    )
    .bind(objectType, objectId)
    .all<ComplianceCheck>();
  return result.results ?? [];
}

export interface ComplianceSummary {
  blockers: number;
  warnings: number;
  info: number;
  total: number;
  byType: Record<string, number>;
}

export async function summarizeOpenChecksForMonth(
  db: D1Database,
  month: string,
): Promise<ComplianceSummary> {
  const result = await db
    .prepare(
      `SELECT rcc.severity, rcc.check_type
       FROM receipt_compliance_checks rcc
       JOIN receipt_records rr ON rr.id = rcc.object_id
       WHERE rcc.object_type = 'receipt'
         AND rcc.status = 'open'
         AND (rr.transaction_date LIKE ? OR rr.exported_month = ?)
         AND rr.deleted_at IS NULL`,
    )
    .bind(`${month}%`, month)
    .all<{ severity: ComplianceCheckSeverity; check_type: string }>();

  const summary: ComplianceSummary = {
    blockers: 0,
    warnings: 0,
    info: 0,
    total: 0,
    byType: {},
  };
  for (const row of result.results ?? []) {
    summary.total++;
    if (row.severity === "blocker") summary.blockers++;
    else if (row.severity === "warning") summary.warnings++;
    else summary.info++;
    summary.byType[row.check_type] = (summary.byType[row.check_type] ?? 0) + 1;
  }
  return summary;
}

/**
 * High-level helper: load the receipt + attendees + files + settings, run
 * the engine, persist results, and return the computed checks.
 */
export async function runComplianceChecksForReceipt(
  db: D1Database,
  receiptId: string,
  settings: ComplianceSettings,
): Promise<ComputedCheck[]> {
  const receipt = await db
    .prepare(`SELECT * FROM receipt_records WHERE id = ? LIMIT 1`)
    .bind(receiptId)
    .first<ReceiptRecord>();
  if (!receipt) return [];

  const attendeesResult = await db
    .prepare(`SELECT * FROM receipt_attendees WHERE receipt_id = ?`)
    .bind(receiptId)
    .all<ReceiptAttendee>();

  const files = await listFilesForObject("receipt", receiptId);

  const computed = computeReceiptChecks({
    receipt,
    attendees: attendeesResult.results ?? [],
    files,
    settings,
  });

  await persistReceiptChecks(db, receiptId, computed);
  return computed;
}
