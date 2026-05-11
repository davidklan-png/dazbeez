-- Indexes that should have been added alongside earlier migrations but were
-- missed. Every query against receipt_records filters on deleted_at IS NULL,
-- and the reconciliation page also filters on payment_path; without these
-- indexes the planner falls back to a full scan as the table grows.

CREATE INDEX IF NOT EXISTS idx_receipts_deleted_at
  ON receipt_records(deleted_at);

CREATE INDEX IF NOT EXISTS idx_receipts_payment_path_deleted_at
  ON receipt_records(payment_path, deleted_at);
