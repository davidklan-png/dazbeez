-- Wipe ALL AMEX statement data so files can be re-imported with fresh code.
-- Receipts (receipt_records) are NOT touched.
--
-- Run on the Mac:
--   wrangler d1 execute RECEIPTS_DB --remote --file db/receipts/scripts/wipe-amex.sql
-- Or against local D1:
--   wrangler d1 execute RECEIPTS_DB --local  --file db/receipts/scripts/wipe-amex.sql

-- 1. Detach any receipts from AMEX lines (lines are about to be deleted)
UPDATE receipt_records
SET    status = 'needs_review',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE  status = 'reconciled'
  AND  payment_path = 'AMEX';

-- 2. AMEX-derived business trip data
DELETE FROM business_trip_report_lines;
DELETE FROM business_trip_reports;

-- 3. Per-line attendees (also CASCADE-deleted by step 4, but explicit for clarity)
DELETE FROM amex_line_attendees;

-- 4. The statement lines themselves
DELETE FROM amex_statement_lines;

-- 5. Upload artifacts (this clears the "already been uploaded" guard)
DELETE FROM amex_statement_artifacts;

-- 6. Audit log entries for AMEX activity (optional — keeps the log focused on receipts)
DELETE FROM receipt_audit_log WHERE action LIKE 'amex.%';
