export type { ExpenseCategoryCode } from "./categories";

export type PaymentPath = "AMEX" | "CASH" | "DIGITAL" | "UNKNOWN";

export type ExpenseType =
  | "meeting-no-alcohol"
  | "entertainment-alcohol"
  | "transportation"
  | "books"
  | "research"
  | "insurance"
  | "software"
  | "telecom"
  | "office_supplies"
  | "travel"
  | "business_trip"
  | "misc"
  | "UNKNOWN";

export type ReceiptStatus =
  | "captured"
  | "needs_review"
  | "reviewed"
  | "reconciled"
  | "exported"
  | "archived";

// Internal extraction-queue state (ADR 0001). Distinct from ReceiptStatus,
// which is the user-facing lifecycle. A receipt can be status='captured' with
// extraction_state 'captured' | 'queued' | 'processing' — all of which mean
// "pending processing" — until the Mac consumer produces fields and advances
// it to status='needs_review' with extraction_state='processed'.
export type ExtractionState =
  | "captured"
  | "queued"
  | "processing"
  | "processed"
  | "failed";

/** States where a capture is enqueued/in-flight but not yet processed. */
export const PENDING_EXTRACTION_STATES: readonly ExtractionState[] = [
  "captured",
  "queued",
  "processing",
];

export type AmexMatchStatus =
  | "unmatched"
  | "matched"
  | "confirmed"
  | "no_receipt";

export type AmexExpenseCategory =
  | "meeting_no_alcohol"
  | "entertainment_alcohol"
  | "transportation"
  | "books"
  | "research"
  | "insurance"
  | "software"
  | "telecom"
  | "office_supplies"
  | "travel"
  | "business_trip"
  | "misc"
  | "unknown";

export type AmexCategoryStatus = "uncategorized" | "suggested" | "confirmed";

export type AmexReceiptStatus =
  | "missing_receipt"
  | "matched"
  | "no_receipt_required"
  | "receipt_not_available";

export type AmexBusinessTripStatus =
  | "not_applicable"
  | "candidate"
  | "confirmed"
  | "excluded";

export type AmexArtifactImportStatus =
  | "uploaded"
  | "parsed"
  | "failed"
  | "replaced"
  | "archived";

export type BusinessTripStatus =
  | "candidate"
  | "confirmed"
  | "rejected"
  | "exported";

export type ExportStatus = "draft" | "finalized";

export type AmexReconciliationStatus = "draft" | "finalized";

export type AuditAction =
  | "receipt.uploaded"
  | "receipt.created"
  | "receipt.updated"
  | "receipt.extracted"
  | "receipt.extraction_requested"
  | "receipt.extraction_completed"
  | "receipt.extraction_denied"
  | "receipt.extraction_failed"
  | "receipt.reviewed"
  | "receipt.reconciled"
  | "receipt.exported"
  | "receipt.archived"
  | "receipt.deleted"
  | "receipt.restored"
  | "receipt.finalized"
  | "receipt.file_downloaded"
  | "receipt.search_performed"
  | "receipt.compliance_checked"
  | "amex.imported"
  | "amex.artifact_created"
  | "amex.line_categorized"
  | "amex.reconciled"
  | "amex.business_trip_detected"
  | "amex.reconciliation_signed_off"
  | "amex.reconciliation_amended"
  | "amex_statement.uploaded"
  | "amex_statement.parsed"
  | "amex_statement.import_failed"
  | "amex_statement.line_updated"
  | "amex_statement.line_reconciled"
  | "export.created"
  | "export.generated"
  | "export.finalized"
  | "export.revision_created"
  | "archive.created"
  | "settings.updated";

// ─── Compliance: source / preservation / qualified-invoice ────────────────

export type SourceType =
  | "paper_scanned"
  | "electronic_receipt"
  | "digital_invoice"
  | "credit_card_statement"
  | "email_attachment"
  | "manual_upload"
  | "amex_csv";

export type PreservationStatus =
  | "captured"
  | "needs_metadata"
  | "needs_review"
  | "reviewed"
  | "exported"
  | "archived"
  | "superseded"
  | "deleted";

export type QualifiedInvoiceStatus =
  | "not_checked"
  | "not_applicable"
  | "valid"
  | "invalid"
  | "missing_registration_number"
  | "unregistered_counterparty"
  | "needs_review";

export type InvoiceRegistrationStatus =
  | "unchecked"
  | "format_valid"
  | "format_invalid"
  | "lookup_skipped"
  | "lookup_confirmed"
  | "lookup_failed";

export type ComplianceCheckType =
  | "missing_transaction_date"
  | "missing_amount"
  | "missing_counterparty"
  | "missing_category"
  | "missing_receipt"
  | "missing_attendees"
  | "missing_invoice_registration_number"
  | "invoice_registration_invalid"
  | "missing_tax_rate"
  | "missing_tax_amount"
  | "electronic_transaction_missing_original"
  | "scanner_preservation_metadata_incomplete"
  | "export_blocker";

export type ComplianceCheckStatus = "open" | "resolved" | "ignored_with_reason";
export type ComplianceCheckSeverity = "info" | "warning" | "blocker";

export type ReceiptFileRole =
  | "original"
  | "processed"
  | "back_side"
  | "continuation"
  | "related_invoice"
  | "statement"
  | "export_artifact";

// ─── Database row shapes ───────────────────────────────────────────────────

export interface ReceiptRecord {
  id: string;
  captured_at: string;
  captured_by: string;
  source: string;
  original_filename: string | null;
  payment_path: PaymentPath;
  expense_type: ExpenseType;
  transaction_date: string | null;
  merchant: string | null;
  amount_minor: number | null;
  currency: string;
  tax_amount_minor: number | null;
  business_purpose: string | null;
  alcohol_present: number;
  attendees_required: number;
  status: ReceiptStatus;
  original_r2_key: string;
  original_sha256: string;
  original_content_type: string;
  original_size_bytes: number;
  processed_r2_key: string | null;
  extraction_json: string | null;
  legacy: number;
  exported_month: string | null;
  expense_category_code: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  retention_until?: string | null;
  legal_hold?: number;
  // Compliance metadata (0014_compliance.sql)
  source_type?: SourceType | null;
  preservation_status?: PreservationStatus | null;
  confirmed_at?: string | null;
  confirmed_by?: string | null;
  invoice_registration_number?: string | null;
  invoice_registration_status?: InvoiceRegistrationStatus | null;
  qualified_invoice_status?: QualifiedInvoiceStatus;
  tax_rate?: string | null;
  counterparty_name?: string | null;
  search_text?: string | null;
  compliance_warnings_json?: string | null;
  // Extraction queue state (0016_extraction_queue.sql, ADR 0001)
  extraction_state?: ExtractionState;
  extraction_enqueued_at?: string | null;
  extraction_processed_at?: string | null;
  extraction_attempts?: number;
  extraction_processor?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceiptAttendee {
  id: string;
  receipt_id: string;
  attendee_name: string;
  company: string | null;
  relationship: string | null;
  is_dazbeez_employee: number;
  notes: string | null;
  created_at: string;
}

export interface AmexStatementLine {
  id: string;
  statement_month: string;
  transaction_date: string;
  posting_date: string | null;
  merchant: string;
  amount_minor: number;
  currency: string;
  amex_reference: string | null;
  matched_receipt_id: string | null;
  match_status: AmexMatchStatus;
  raw_json: string;
  created_at: string;
  // Extended fields (added in migration 0005)
  statement_artifact_id: string | null;
  cardholder_name: string | null;
  cardholder_flag: string | null;
  payment_type: string | null;
  prepayment_flag: string | null;
  memo: string | null;
  raw_csv_line_number: number | null;
  source_file_sha256: string | null;
  imported_at: string | null;
  expense_category: AmexExpenseCategory;
  category_status: AmexCategoryStatus;
  receipt_status: AmexReceiptStatus;
  receipt_missing_reason: string | null;
  business_trip_id: string | null;
  business_trip_status: AmexBusinessTripStatus;
  expense_category_code: string | null;
  re_review_needed: 0 | 1;
  updated_at: string | null;
}

export interface AmexStatementArtifact {
  id: string;
  statement_month: string;
  payment_due_date: string | null;
  card_name: string | null;
  original_filename: string | null;
  r2_key: string;
  mime_type: string;
  encoding: string | null;
  sha256_hash: string;
  file_size_bytes: number;
  uploaded_by: string;
  uploaded_at: string;
  import_status: AmexArtifactImportStatus;
  row_count: number | null;
  transaction_count: number | null;
  statement_total_amount_cents: number | null;
  parsed_total_amount_cents: number | null;
  validation_errors_json: string | null;
  retention_until?: string | null;
  legal_hold?: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardAlertDismissal {
  id: string;
  alert_type: string;
  alert_key: string;
  dismissed_by: string;
  dismissed_at: string;
  expires_at: string;
  created_at: string;
}

export interface AmexLineAttendee {
  id: string;
  amex_statement_line_id: string;
  attendee_name: string;
  company: string | null;
  relationship: string | null;
  is_dazbeez_employee: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessTripReport {
  id: string;
  trip_name: string | null;
  cardholder_name: string;
  start_date: string;
  end_date: string;
  primary_location: string | null;
  status: BusinessTripStatus;
  purpose: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessTripReportLine {
  id: string;
  business_trip_report_id: string;
  amex_statement_line_id: string;
  created_at: string;
}

export interface ReceiptExport {
  id: string;
  export_month: string;
  status: ExportStatus;
  archive_r2_key: string | null;
  manifest_r2_key: string | null;
  archive_sha256: string | null;
  created_by: string;
  created_at: string;
  finalized_at: string | null;
  retention_until?: string | null;
  legal_hold?: number;
  // Revisioning + manifest hashing (0014_compliance.sql)
  export_revision?: number;
  supersedes_export_id?: string | null;
  correction_reason?: string | null;
  finalized_by?: string | null;
  finalization_hash?: string | null;
  manifest_sha256?: string | null;
}

// ─── Compliance row shapes ────────────────────────────────────────────────

export interface ReceiptFile {
  id: string;
  object_type: string;
  object_id: string;
  role: ReceiptFileRole;
  r2_bucket: string;
  r2_key: string;
  original_filename: string;
  content_type: string;
  file_size_bytes: number;
  sha256_hash: string;
  uploaded_by: string;
  uploaded_at: string;
  is_original: number;
  created_at: string;
  updated_at: string;
}

export interface ComplianceCheck {
  id: string;
  object_type: string;
  object_id: string;
  check_type: ComplianceCheckType;
  status: ComplianceCheckStatus;
  severity: ComplianceCheckSeverity;
  message: string;
  details_json: string | null;
  checked_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

export interface ComputedCheck {
  checkType: ComplianceCheckType;
  severity: ComplianceCheckSeverity;
  message: string;
  details?: Record<string, unknown>;
}

export type InvoiceNumberRequirementMode = "disabled" | "warning" | "blocker";

export type PaperOriginalDiscardPolicy =
  | "retain_until_accountant_confirms"
  | "retain_indefinitely"
  | "permit_discard_after_scan";

export interface ComplianceSettings {
  business_name: string;
  taxpayer_type: string;
  retention_years: number;
  require_attendees_for_meeting: boolean;
  require_attendees_for_entertainment: boolean;
  invoice_number_requirement_mode: InvoiceNumberRequirementMode;
  export_block_on_warnings: boolean;
  paper_original_discard_policy: PaperOriginalDiscardPolicy;
  statement_expected_day: number;
}

export interface AmexReconciliation {
  id: string;
  statement_month: string;
  statement_artifact_id: string | null;
  status: AmexReconciliationStatus;
  manifest_r2_key: string | null;
  manifest_sha256: string | null;
  line_count: number;
  matched_count: number;
  no_receipt_count: number;
  created_by: string;
  created_at: string;
  finalized_by: string | null;
  finalized_at: string | null;
  retention_until?: string | null;
  legal_hold?: number;
}

export interface ReceiptAuditEntry {
  id: string;
  actor: string;
  action: AuditAction;
  object_type: string;
  object_id: string;
  old_value_json: string | null;
  new_value_json: string | null;
  created_at: string;
}

// ─── Input/payload shapes ──────────────────────────────────────────────────

export interface CreateReceiptInput {
  capturedBy: string;
  source?: string;
  sourceType?: SourceType;
  originalFilename?: string;
  paymentPath?: PaymentPath;
  expenseType?: ExpenseType;
  transactionDate?: string;
  merchant?: string;
  amountMinor?: number;
  currency?: string;
  taxAmountMinor?: number;
  businessPurpose?: string;
  alcoholPresent?: boolean;
  originalR2Key: string;
  originalSha256: string;
  originalContentType: string;
  originalSizeBytes: number;
  // Lifecycle status to insert at. Defaults to 'needs_review' (legacy /
  // synchronous path). The async capture path (ADR 0001) passes 'captured',
  // which also seeds extraction_state='captured' (pending processing).
  status?: ReceiptStatus;
}

export interface UpdateReceiptInput {
  paymentPath?: PaymentPath;
  expenseType?: ExpenseType;
  expenseCategoryCode?: string | null;
  transactionDate?: string | null;
  merchant?: string | null;
  amountMinor?: number | null;
  currency?: string;
  taxAmountMinor?: number | null;
  businessPurpose?: string | null;
  alcoholPresent?: boolean;
  status?: ReceiptStatus;
  processedR2Key?: string | null;
  extractionJson?: string | null;
  exportedMonth?: string | null;
  // Compliance fields (0014_compliance.sql)
  sourceType?: SourceType | null;
  invoiceRegistrationNumber?: string | null;
  counterpartyName?: string | null;
  taxRate?: string | null;
  qualifiedInvoiceStatus?: QualifiedInvoiceStatus | null;
  // Extraction queue state (0016_extraction_queue.sql, ADR 0001)
  extractionState?: ExtractionState;
  extractionEnqueuedAt?: string | null;
  extractionProcessedAt?: string | null;
  extractionAttempts?: number;
  extractionProcessor?: string | null;
}

export interface CreateAttendeeInput {
  attendeeName: string;
  company?: string;
  relationship?: string;
  isDazbeezEmployee?: boolean;
  notes?: string;
}

export interface ImportAmexLineInput {
  statementMonth: string;
  transactionDate: string;
  postingDate?: string;
  merchant: string;
  amountMinor: number;
  currency?: string;
  amexReference?: string;
  rawJson: string;
  // Extended fields from Netアンサー parser
  statementArtifactId?: string;
  cardholderName?: string;
  cardholderFlag?: string;
  paymentType?: string;
  prepaymentFlag?: string;
  memo?: string;
  rawCsvLineNumber?: number;
  sourceFileSha256?: string;
}

export interface CreateAmexArtifactInput {
  statementMonth: string;
  paymentDueDate: string | null;
  cardName: string | null;
  originalFilename: string;
  r2Key: string;
  encoding: string | null;
  sha256Hash: string;
  fileSizeBytes: number;
  uploadedBy: string;
  statementTotalAmountCents: number | null;
  parsedTotalAmountCents: number | null;
  transactionCount: number;
  rowCount: number;
  validationErrors: string[];
  importStatus: AmexArtifactImportStatus;
}

export interface UpdateAmexLineCategoryInput {
  expenseCategory?: AmexExpenseCategory;
  expenseCategoryCode?: string | null;
  categoryStatus?: AmexCategoryStatus;
  receiptStatus?: AmexReceiptStatus;
  receiptMissingReason?: string | null;
  businessTripStatus?: AmexBusinessTripStatus;
}

// ─── Extraction ────────────────────────────────────────────────────────────

export interface ExtractionResult {
  transactionDate: string | null;
  merchant: string | null;
  amountMinor: number | null;
  currency: string | null;
  expenseType: ExpenseType | null;
  expenseCategoryCode: string | null;
  businessPurpose: string | null;
  attendeeNames: string[];
  rawText: string;
  provider: string;
  // Qualified-invoice (インボイス制度) extraction. Initial providers may
  // leave these null; the review UI is the source of truth until populated.
  invoiceRegistrationNumber?: string | null;
  taxRate?: string | null;
  taxAmountMinor?: number | null;
  counterpartyName?: string | null;
  qualifiedInvoiceStatus?: QualifiedInvoiceStatus | null;
}

// ─── Reconciliation ────────────────────────────────────────────────────────

export interface ReconciliationMatch {
  amexLineId: string;
  receiptId: string;
  confidenceScore: number;
  matchReasons: string[];
}

// ─── Business trip detection ───────────────────────────────────────────────

export interface BusinessTripCandidate {
  cardholderName: string;
  startDate: string;
  endDate: string;
  primaryLocation: string;
  lineIds: string[];
}

// ─── Export ────────────────────────────────────────────────────────────────

export interface ExportRow {
  receiptId: string;
  transactionDate: string | null;
  merchant: string | null;
  amountMinor: number | null;
  currency: string;
  expenseType: ExpenseType;
  expenseCategoryCode: string | null;
  expenseCategoryJa: string | null;
  expenseCategoryEn: string | null;
  paymentPath: PaymentPath;
  businessPurpose: string | null;
  attendees: string[];
  status: ReceiptStatus;
  originalR2Key: string;
}

// ─── Dashboard alerts ──────────────────────────────────────────────────────

export interface MissingStatementAlert {
  statementMonth: string;
  expectedReadyDate: string;
  dismissed: boolean;
}
