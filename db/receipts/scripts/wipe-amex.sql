-- Wipe ALL AMEX statement data so files can be re-imported with fresh code.
-- Receipts (receipt_records) are NOT touched.
--
-- Run on the Mac (one statement at a time to avoid multi-statement parser issues):
--   wrangler d1 execute RECEIPTS_DB --remote --command "UPDATE receipt_records SET status = 'needs_review' WHERE status = 'reconciled' AND payment_path = 'AMEX'"
--   wrangler d1 execute RECEIPTS_DB --remote --command "DELETE FROM business_trip_report_lines"
--   wrangler d1 execute RECEIPTS_DB --remote --command "DELETE FROM business_trip_reports"
--   wrangler d1 execute RECEIPTS_DB --remote --command "DELETE FROM amex_line_attendees"
--   wrangler d1 execute RECEIPTS_DB --remote --command "DELETE FROM amex_statement_lines"
--   wrangler d1 execute RECEIPTS_DB --remote --command "DELETE FROM amex_statement_artifacts"
--   wrangler d1 execute RECEIPTS_DB --remote --command "DELETE FROM receipt_audit_log WHERE action IN ('amex.artifact_created','amex.business_trip_detected','amex.imported','amex.line_categorized','amex.reconciled')"

UPDATE receipt_records
SET    status = 'needs_review'
WHERE  status = 'reconciled'
  AND  payment_path = 'AMEX';

DELETE FROM business_trip_report_lines;
DELETE FROM business_trip_reports;
DELETE FROM amex_line_attendees;
DELETE FROM amex_statement_lines;
DELETE FROM amex_statement_artifacts;

DELETE FROM receipt_audit_log
WHERE action IN (
  'amex.artifact_created',
  'amex.business_trip_detected',
  'amex.imported',
  'amex.line_categorized',
  'amex.reconciled'
);
