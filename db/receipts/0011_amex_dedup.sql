-- 0011_amex_dedup.sql
--
-- Stable AMEX line identity across re-imports
-- ============================================
-- When an operator re-uploads a corrected CSV for a month, the import
-- flow uses INSERT … ON CONFLICT DO UPDATE (upsert) instead of
-- INSERT OR IGNORE.  This preserves the PK (id) and all reconciliation
-- state (matched_receipt_id, match_status, receipt_status, etc.) while
-- refreshing the CSV-sourced fields (dates, merchant, amount, raw_json).
--
-- Primary dedup key: (statement_month, amex_reference, cardholder_name)
--   AMEX reference numbers are unique per transaction within a
--   cardholder's statement, making this a reliable identity key.
--
-- Null-reference fallback: (statement_month, transaction_date,
--   amount_minor, merchant, cardholder_name).
--   AMEX Netアンサー CSVs always populate the Reference field for
--   charge lines, so null references are exceedingly rare (typically
--   header/footer rows filtered by the parser).  This fallback prevents
--   accidental duplicates for any non-standard import.
--   Note: if cardholder_name is also NULL, SQLite treats NULLs as
--   distinct in unique indexes, so two charges at the same merchant
--   on the same date for the same amount with unknown cardholders will
--   still be treated as separate rows — the safe default.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_amex_line_dedup
  ON amex_statement_lines(statement_month, amex_reference, cardholder_name)
  WHERE amex_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_amex_line_null_ref
  ON amex_statement_lines(statement_month, transaction_date, amount_minor, merchant, cardholder_name)
  WHERE amex_reference IS NULL;
