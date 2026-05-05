-- Receipt Module: initial schema
-- Run: npx wrangler d1 migrations apply RECEIPTS_DB [--local]

CREATE TABLE IF NOT EXISTS receipt_records (
  id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  captured_by TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload',
  original_filename TEXT,
  payment_path TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (payment_path IN ('AMEX','CASH','DIGITAL','UNKNOWN')),
  expense_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  transaction_date TEXT,
  merchant TEXT,
  amount_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'JPY',
  tax_amount_minor INTEGER,
  business_purpose TEXT,
  alcohol_present INTEGER NOT NULL DEFAULT 0,
  attendees_required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'captured'
    CHECK (status IN ('captured','needs_review','reviewed','reconciled','exported','archived')),
  original_r2_key TEXT NOT NULL UNIQUE,
  original_sha256 TEXT NOT NULL,
  original_content_type TEXT NOT NULL,
  original_size_bytes INTEGER NOT NULL,
  processed_r2_key TEXT,
  extraction_json TEXT,
  legacy INTEGER NOT NULL DEFAULT 0,
  exported_month TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_attendees (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipt_records(id) ON DELETE CASCADE,
  attendee_name TEXT NOT NULL,
  company TEXT,
  relationship TEXT,
  is_dazbeez_employee INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS amex_statement_lines (
  id TEXT PRIMARY KEY,
  statement_month TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  posting_date TEXT,
  merchant TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  amex_reference TEXT,
  matched_receipt_id TEXT REFERENCES receipt_records(id),
  match_status TEXT NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('unmatched','matched','confirmed','no_receipt')),
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_exports (
  id TEXT PRIMARY KEY,
  export_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','finalized')),
  archive_r2_key TEXT,
  manifest_r2_key TEXT,
  archive_sha256 TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS receipt_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_transaction_date ON receipt_records(transaction_date);
CREATE INDEX IF NOT EXISTS idx_receipts_payment_path ON receipt_records(payment_path);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipt_records(status);
CREATE INDEX IF NOT EXISTS idx_receipts_exported_month ON receipt_records(exported_month);
CREATE INDEX IF NOT EXISTS idx_attendees_receipt_id ON receipt_attendees(receipt_id);
CREATE INDEX IF NOT EXISTS idx_amex_statement_month ON amex_statement_lines(statement_month);
CREATE INDEX IF NOT EXISTS idx_amex_match_status ON amex_statement_lines(match_status);
CREATE INDEX IF NOT EXISTS idx_amex_matched_receipt ON amex_statement_lines(matched_receipt_id);
CREATE INDEX IF NOT EXISTS idx_exports_month ON receipt_exports(export_month);
CREATE INDEX IF NOT EXISTS idx_audit_object ON receipt_audit_log(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON receipt_audit_log(created_at);
