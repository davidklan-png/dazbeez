-- 0012_re_review_flag.sql
--
-- Adds a re_review_needed flag to amex_statement_lines.
-- When a confirmed line's CSV-sourced fields (merchant, amount, date) change
-- on re-import, the import logic sets this flag so the operator knows the
-- reconciliation is stale and needs re-examination.

ALTER TABLE amex_statement_lines
  ADD COLUMN re_review_needed INTEGER NOT NULL DEFAULT 0
  CHECK (re_review_needed IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_amex_lines_re_review
  ON amex_statement_lines(statement_month, re_review_needed)
  WHERE re_review_needed = 1;
