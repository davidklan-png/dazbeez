-- 0036_export_deliveries.sql
--
-- Monthly pack delivery records (Phase B; D2 — "send failure is finalize
-- failure" implemented as a state machine, never a rollback).
--
-- One row per HTTP send attempt to Resend. `attempt_id` groups the automatic
-- retries of a single operator-initiated send (they share the idempotency
-- key, so a network-timeout retry does not double-send). A separate table
-- rather than columns on receipt_exports because retries need attempt history
-- and the idempotency key is per-attempt.
--
-- `delivery_state` on receipt_exports is denormalised for list queries and is
-- written in the SAME D1 batch (transaction) as the export_deliveries row, so
-- the list view never disagrees with the attempt history.
--
-- Additive only. Pre-existing exports read delivery_state = NULL (not
-- delivered); no backfill. The month-closed-for-reporting flag waits on
-- delivery — edit-locking (loadSealedExportMonths, the finalized-reconciliation
-- guard) stays keyed on the seal and is untouched here.
CREATE TABLE export_deliveries (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,        -- one per operator-initiated send; reused by its automatic retries
  idempotency_key TEXT NOT NULL,   -- derived from attempt_id; stable across retries of that attempt
  state TEXT NOT NULL,             -- 'pending' | 'sent' | 'failed'
  to_address TEXT NOT NULL,
  cc_address TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,              -- the exact assembled text sent (D5)
  operator_message TEXT,           -- the free-text portion alone (O7)
  zip_filename TEXT NOT NULL,
  zip_sha256 TEXT NOT NULL,
  zip_bytes INTEGER NOT NULL,
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_export_deliveries_export ON export_deliveries(export_id);
CREATE INDEX idx_export_deliveries_attempt ON export_deliveries(attempt_id);
CREATE INDEX idx_export_deliveries_state ON export_deliveries(state);

ALTER TABLE receipt_exports ADD COLUMN delivery_state TEXT;
