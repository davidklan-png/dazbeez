-- 0020_export_statement_month.sql
--
-- ADR 0006: stored, sticky statement-cycle membership for non-AMEX receipts.
-- Additive only — no existing column is altered or dropped.
--
-- What this enables:
--   * A CASH/DIGITAL receipt's export month is computed from the chained
--     statement-cycle windows window(M) = (close(M-1), close(M)], where
--     close(M) = MAX(transaction_date) over that statement's AMEX lines, and
--     stored here — rather than derived at read time from the calendar month
--     of transaction_date. See docs/adr/0006-...md (§D1 for the close-anchor
--     decision, §D3 for the sticky/freeze rule).
--   * NULL semantics: NULL means "awaiting statement" for CASH/DIGITAL (the
--     receipt's date is beyond the newest imported statement's close) — these
--     are excluded from every bundle and finalize gate. AMEX receipts keep
--     line-based membership (column stays NULL for them); UNKNOWN receipts are
--     scoped at gate time via naturalStatementMonth and are never assigned a
--     stored month.
--
-- PR #1 is ADDITIVE ONLY: this migration adds the column + index but nothing
-- reads it yet. buildExportBundle and the finalize gates still filter by
-- transaction_date. PR #2 flips the bundle to select on this column. The
-- column is backfilled by scripts/backfill-export-statement-month.ts (run
-- manually against remote after this migration applies — it logs every
-- assignment to receipt_audit_log).

ALTER TABLE receipt_records ADD COLUMN export_statement_month TEXT;

-- Hot path (PR #2): buildExportBundle(M) selects non-AMEX receipts by this
-- column. Partial to keep the index lean and to match data semantics — only
-- CASH/DIGITAL rows carry a value; AMEX/UNKNOWN/awaiting stay NULL and don't
-- index. Soft-deleted rows carry whatever value they had; queries add the
-- deleted_at IS NULL filter themselves.
CREATE INDEX IF NOT EXISTS idx_receipts_export_statement_month
  ON receipt_records(export_statement_month)
  WHERE payment_path IN ('CASH', 'DIGITAL');
