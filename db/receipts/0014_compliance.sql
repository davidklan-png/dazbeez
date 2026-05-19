-- 0014_compliance.sql
--
-- Japanese tax-document preservation compliance layer.
-- Adds:
--   - source_type / preservation_status / qualified invoice / search metadata
--     fields on receipt_records
--   - receipt_files file manifest (one original + N derivatives per object)
--   - receipt_compliance_checks (engine output, persisted)
--   - receipt_settings key/value store for compliance configuration
--   - export_revision / supersedes_export_id / correction_reason / finalized_by
--     / finalization_hash / manifest_sha256 on receipt_exports
--   - additional search indexes
--
-- All changes are additive. Enum-like columns (source_type, preservation_status,
-- qualified_invoice_status, invoice_registration_status) are enforced in the
-- application layer (lib/receipts/compliance.ts) because SQLite cannot ALTER
-- an existing column to add a CHECK constraint.

-- ── receipt_records: compliance metadata ─────────────────────────────────────
ALTER TABLE receipt_records ADD COLUMN source_type TEXT;
ALTER TABLE receipt_records ADD COLUMN preservation_status TEXT;
ALTER TABLE receipt_records ADD COLUMN confirmed_at TEXT;
ALTER TABLE receipt_records ADD COLUMN confirmed_by TEXT;
ALTER TABLE receipt_records ADD COLUMN invoice_registration_number TEXT;
ALTER TABLE receipt_records ADD COLUMN invoice_registration_status TEXT;
ALTER TABLE receipt_records ADD COLUMN qualified_invoice_status TEXT NOT NULL DEFAULT 'not_checked';
ALTER TABLE receipt_records ADD COLUMN tax_rate TEXT;
ALTER TABLE receipt_records ADD COLUMN counterparty_name TEXT;
ALTER TABLE receipt_records ADD COLUMN search_text TEXT;
ALTER TABLE receipt_records ADD COLUMN compliance_warnings_json TEXT;

-- ── File manifest ────────────────────────────────────────────────────────────
-- One original + N derivatives per receipt; also tracks AMEX statement
-- artifacts and export bundles under different object_type values.
CREATE TABLE IF NOT EXISTS receipt_files (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  role TEXT NOT NULL,
  r2_bucket TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  sha256_hash TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  is_original INTEGER NOT NULL DEFAULT 0 CHECK (is_original IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_files_object ON receipt_files(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_receipt_files_sha ON receipt_files(sha256_hash);

-- ── Compliance checks ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipt_compliance_checks (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  check_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'ignored_with_reason')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocker')),
  message TEXT NOT NULL,
  details_json TEXT,
  checked_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compliance_object ON receipt_compliance_checks(object_type, object_id, status);
CREATE INDEX IF NOT EXISTS idx_compliance_open ON receipt_compliance_checks(check_type, status);

-- ── Compliance settings (key/value store) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipt_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

INSERT OR IGNORE INTO receipt_settings (key, value, updated_at, updated_by) VALUES
  ('business_name',                       '',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system'),
  ('taxpayer_type',                       'kojin',   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system'),
  ('retention_years',                     '7',       strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system'),
  ('require_attendees_for_meeting',       'true',    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system'),
  ('require_attendees_for_entertainment', 'true',    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system'),
  ('invoice_number_requirement_mode',     'warning', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system'),
  ('export_block_on_warnings',            'false',   strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system'),
  ('paper_original_discard_policy',       'retain_until_accountant_confirms', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system'),
  ('statement_expected_day',              '18',      strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system');

-- ── receipt_exports: revisioning + manifest hash ─────────────────────────────
ALTER TABLE receipt_exports ADD COLUMN export_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE receipt_exports ADD COLUMN supersedes_export_id TEXT;
ALTER TABLE receipt_exports ADD COLUMN correction_reason TEXT;
ALTER TABLE receipt_exports ADD COLUMN finalized_by TEXT;
ALTER TABLE receipt_exports ADD COLUMN finalization_hash TEXT;
ALTER TABLE receipt_exports ADD COLUMN manifest_sha256 TEXT;

-- ── Search indexes ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_receipts_amount ON receipt_records(amount_minor);
CREATE INDEX IF NOT EXISTS idx_receipts_merchant ON receipt_records(merchant);
CREATE INDEX IF NOT EXISTS idx_receipts_source_type ON receipt_records(source_type);
CREATE INDEX IF NOT EXISTS idx_receipts_invoice_no ON receipt_records(invoice_registration_number);
CREATE INDEX IF NOT EXISTS idx_receipts_counterparty ON receipt_records(counterparty_name);
CREATE INDEX IF NOT EXISTS idx_amex_amount ON amex_statement_lines(amount_minor);
CREATE INDEX IF NOT EXISTS idx_amex_merchant ON amex_statement_lines(merchant);

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Existing receipts predate the source_type / preservation_status concept.
-- Treat them as manual uploads with preservation status derived from status.
UPDATE receipt_records
SET source_type = 'manual_upload'
WHERE source_type IS NULL;

UPDATE receipt_records
SET preservation_status = CASE
  WHEN status = 'archived' THEN 'archived'
  WHEN status = 'exported' THEN 'exported'
  WHEN status = 'reconciled' THEN 'reviewed'
  WHEN status = 'reviewed' THEN 'reviewed'
  WHEN status = 'captured' THEN 'needs_metadata'
  ELSE 'needs_review'
END
WHERE preservation_status IS NULL;
