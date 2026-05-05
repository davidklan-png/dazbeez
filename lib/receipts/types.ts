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

export type AuditAction =
  | "receipt.uploaded"
  | "receipt.created"
  | "receipt.updated"
  | "receipt.extracted"
  | "receipt.extraction_requested"
  | "receipt.extraction_completed"
  | "receipt.extraction_failed"
  | "receipt.reconciled"
  | "receipt.exported"
  | "receipt.archived"
  | "receipt.deleted"
  | "amex.imported"
  | "amex.artifact_created"
  | "amex.line_categorized"
  | "amex.reconciled"
  | "amex.business_trip_detected"
  | "export.created"
  | "export.finalized";

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
