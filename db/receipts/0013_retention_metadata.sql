-- 0013_retention_metadata.sql
--
-- Conservative tax-record retention metadata. The application writes a
-- 10-year retention horizon for new records and annotates R2 objects with the
-- same policy. Existing rows are backfilled from their creation/upload date
-- where available.

ALTER TABLE receipt_records ADD COLUMN retention_until TEXT;
ALTER TABLE receipt_records ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 1
  CHECK (legal_hold IN (0, 1));

ALTER TABLE amex_statement_artifacts ADD COLUMN retention_until TEXT;
ALTER TABLE amex_statement_artifacts ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 1
  CHECK (legal_hold IN (0, 1));

ALTER TABLE receipt_exports ADD COLUMN retention_until TEXT;
ALTER TABLE receipt_exports ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 1
  CHECK (legal_hold IN (0, 1));

ALTER TABLE amex_reconciliations ADD COLUMN retention_until TEXT;
ALTER TABLE amex_reconciliations ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 1
  CHECK (legal_hold IN (0, 1));

UPDATE receipt_records
SET retention_until = strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(created_at, captured_at), '+10 years')
WHERE retention_until IS NULL;

UPDATE amex_statement_artifacts
SET retention_until = strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(created_at, uploaded_at), '+10 years')
WHERE retention_until IS NULL;

UPDATE receipt_exports
SET retention_until = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+10 years')
WHERE retention_until IS NULL;

UPDATE amex_reconciliations
SET retention_until = strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+10 years')
WHERE retention_until IS NULL;
