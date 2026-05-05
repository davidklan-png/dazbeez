-- Migration 0005: Extended AMEX schema — artifacts, line enrichment, alerts, business trips

-- ── Extend amex_statement_lines ───────────────────────────────────────────────
ALTER TABLE amex_statement_lines ADD COLUMN statement_artifact_id TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN cardholder_name TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN cardholder_flag TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN payment_type TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN prepayment_flag TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN memo TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN raw_csv_line_number INTEGER;
ALTER TABLE amex_statement_lines ADD COLUMN source_file_sha256 TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN imported_at TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN expense_category TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE amex_statement_lines ADD COLUMN category_status TEXT NOT NULL DEFAULT 'uncategorized';
ALTER TABLE amex_statement_lines ADD COLUMN receipt_status TEXT NOT NULL DEFAULT 'missing_receipt';
ALTER TABLE amex_statement_lines ADD COLUMN receipt_missing_reason TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN business_trip_id TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN business_trip_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE amex_statement_lines ADD COLUMN updated_at TEXT;

-- ── AMEX statement artifacts ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amex_statement_artifacts (
  id TEXT PRIMARY KEY,
  statement_month TEXT NOT NULL,
  payment_due_date TEXT,
  card_name TEXT,
  original_filename TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'text/csv',
  encoding TEXT,
  sha256_hash TEXT NOT NULL UNIQUE,
  file_size_bytes INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  import_status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (import_status IN ('uploaded','parsed','failed','replaced','archived')),
  row_count INTEGER,
  transaction_count INTEGER,
  statement_total_amount_cents INTEGER,
  parsed_total_amount_cents INTEGER,
  validation_errors_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── Dashboard alert dismissals ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dashboard_alert_dismissals (
  id TEXT PRIMARY KEY,
  alert_type TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (alert_type, alert_key, dismissed_by)
);

-- ── AMEX line attendees ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amex_line_attendees (
  id TEXT PRIMARY KEY,
  amex_statement_line_id TEXT NOT NULL REFERENCES amex_statement_lines(id) ON DELETE CASCADE,
  attendee_name TEXT NOT NULL,
  company TEXT,
  relationship TEXT,
  is_dazbeez_employee INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── Business trip reports ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS business_trip_reports (
  id TEXT PRIMARY KEY,
  trip_name TEXT,
  cardholder_name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  primary_location TEXT,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','confirmed','rejected','exported')),
  purpose TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS business_trip_report_lines (
  id TEXT PRIMARY KEY,
  business_trip_report_id TEXT NOT NULL REFERENCES business_trip_reports(id) ON DELETE CASCADE,
  amex_statement_line_id TEXT NOT NULL REFERENCES amex_statement_lines(id),
  created_at TEXT NOT NULL,
  UNIQUE (business_trip_report_id, amex_statement_line_id)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_amex_artifact_month ON amex_statement_artifacts(statement_month);
CREATE INDEX IF NOT EXISTS idx_amex_artifact_sha256 ON amex_statement_artifacts(sha256_hash);
CREATE INDEX IF NOT EXISTS idx_amex_artifact_id ON amex_statement_lines(statement_artifact_id);
CREATE INDEX IF NOT EXISTS idx_amex_category ON amex_statement_lines(expense_category);
CREATE INDEX IF NOT EXISTS idx_amex_receipt_status ON amex_statement_lines(receipt_status);
CREATE INDEX IF NOT EXISTS idx_alert_dismissals ON dashboard_alert_dismissals(alert_type, alert_key);
CREATE INDEX IF NOT EXISTS idx_amex_line_attendees ON amex_line_attendees(amex_statement_line_id);
CREATE INDEX IF NOT EXISTS idx_business_trips ON business_trip_reports(cardholder_name, start_date);
CREATE INDEX IF NOT EXISTS idx_business_trip_lines ON business_trip_report_lines(business_trip_report_id);
