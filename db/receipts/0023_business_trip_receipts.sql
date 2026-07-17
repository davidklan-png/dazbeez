-- 0023_business_trip_receipts.sql
--
-- ADR 0010 D2: business trips become first-class, operator-managed entities
-- whose membership is lines AND receipts, date-unconstrained, overlay-only.
-- This adds the receipts link table, mirroring business_trip_report_lines.
--
-- Membership is an overlay: writes touch ONLY link tables (plus
-- business_trip_id / business_trip_status on lines, which any sealed export
-- already snapshotted at seal time — changing them later does not alter a
-- sealed artifact). Receipt rows are NEVER written here, so attaching a
-- sealed-month receipt to a trip is legal by construction (no conflict with
-- the exported-receipt guard or ADR 0009). This is what lets June 2026 close
-- now and gain trip linkage later.
--
-- No other schema change this phase: trip_name/purpose/primary_location and
-- the status CHECK already exist (0005); the homebase setting lives in the
-- key/value receipt_settings table (needs no DDL).
CREATE TABLE IF NOT EXISTS business_trip_report_receipts (
  id TEXT PRIMARY KEY,
  business_trip_report_id TEXT NOT NULL
    REFERENCES business_trip_reports(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (business_trip_report_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS idx_business_trip_receipts
  ON business_trip_report_receipts(business_trip_report_id);
