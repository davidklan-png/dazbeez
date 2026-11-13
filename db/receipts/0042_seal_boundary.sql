-- 0042_seal_boundary.sql
--
-- Receipt build/seal consistency boundary (contract
-- .polly/contracts/receipts-seal-boundary.md, 2026-11-13).
--
-- Two mechanisms, both enforced at SQL statement-execution time so a write that
-- passed JS prechecks still cannot invalidate an in-flight or published seal:
--
--   1. ACTIVE BUILD CLAIM. receipt_exports gains a per-draft expiring lease:
--      sealing_token (fresh unpredictable build id per attempt),
--      sealing_expires_at (unix-epoch seconds, D1-clock derived, +600s).
--      While a month's draft holds an UNEXPIRED claim, every table that feeds
--      the bundle/gate rejects protected writes (triggers below). Expired
--      claims are ignored by every predicate — no writer ever needs to clear
--      another request's lease, and an expired attempt can never publish (the
--      publication UPDATE requires the unexpired lease in its WHERE).
--
--   2. POST-PUBLICATION SEALS, expressed in SQL. The existing JS edit-lock
--      semantics (export lock + reconciliation lock + ADR 0012 draft carve-out,
--      strict line seal, archived-terminal, sealed-row immutability) are
--      restated here as BEFORE triggers so they hold at write time even for
--      paths whose JS precheck was bypassed, raced, or absent.
--
-- Additive only. No column altered/dropped; both 0017 uniqueness indexes and
-- the draft/finalized CHECK are untouched. No cleanup job, no revision
-- automation, no lifecycle-status additions.
--
-- Error identifiers are stable ASCII (DZ_SEAL_*) so the app maps them to 409
-- without parsing driver message text.

ALTER TABLE receipt_exports ADD COLUMN sealing_token TEXT;
ALTER TABLE receipt_exports ADD COLUMN sealing_expires_at INTEGER;
ALTER TABLE receipt_exports ADD COLUMN bundle_build_id TEXT;

-- ─── Shared predicate fragments (inlined per trigger — SQLite triggers have
-- no macros; when a fragment changes, every trigger using it changes) ────────
--
-- Active claim on month M (alias-free; expects M as a SQL expression):
--   EXISTS(SELECT 1 FROM receipt_exports ce
--          WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
--            AND ce.sealing_expires_at IS NOT NULL
--            AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
--            AND ce.export_month IS (M))
--
-- Month edit-locked (existing isMonthLockedForEdits semantics — finalized
-- export AND no open draft; the ADR 0012 carve-out):
--   (EXISTS(SELECT 1 FROM receipt_exports fe
--           WHERE fe.status='finalized' AND fe.export_month IS (M))
--    AND NOT EXISTS(SELECT 1 FROM receipt_exports de
--                   WHERE de.status='draft' AND de.export_month IS (M)))

-- ═══════════════════════════════════════════════════════════════════════════
-- receipt_records
-- ═══════════════════════════════════════════════════════════════════════════

-- Active claim: freeze every gate/bundle input on receipts fenced by the
-- claimed month. Scope = calendar month of transaction_date (the non-AMEX gate
-- scope, incl. UNKNOWN-in-month), stored membership, exported_month, and any
-- AMEX statement month claiming the receipt (cross-month). Claim change-set
-- additionally covers status + extraction_state (both gate inputs).
CREATE TRIGGER IF NOT EXISTS seal_claim_receipt_update
BEFORE UPDATE ON receipt_records
WHEN (
     OLD.payment_path IS NOT NEW.payment_path
  OR OLD.transaction_date IS NOT NEW.transaction_date
  OR OLD.export_statement_month IS NOT NEW.export_statement_month
  OR OLD.exported_month IS NOT NEW.exported_month
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.merchant IS NOT NEW.merchant
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.expense_category_code IS NOT NEW.expense_category_code
  OR OLD.business_purpose IS NOT NEW.business_purpose
  OR OLD.tax_rate IS NOT NEW.tax_rate
  OR OLD.tax_amount_minor IS NOT NEW.tax_amount_minor
  OR OLD.invoice_registration_number IS NOT NEW.invoice_registration_number
  OR OLD.qualified_invoice_status IS NOT NEW.qualified_invoice_status
  OR OLD.counterparty_name IS NOT NEW.counterparty_name
  OR OLD.source_type IS NOT NEW.source_type
  OR OLD.status IS NOT NEW.status
  OR OLD.original_r2_key IS NOT NEW.original_r2_key
  OR OLD.original_sha256 IS NOT NEW.original_sha256
  OR OLD.original_content_type IS NOT NEW.original_content_type
  OR OLD.original_size_bytes IS NOT NEW.original_size_bytes
  OR OLD.extraction_state IS NOT NEW.extraction_state
)
AND (
  EXISTS(SELECT 1 FROM receipt_exports ce
         WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
           AND ce.sealing_expires_at IS NOT NULL
           AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
           AND (ce.export_month IS substr(OLD.transaction_date,1,7)
                OR ce.export_month IS OLD.export_statement_month
                OR ce.export_month IS OLD.exported_month))
  OR EXISTS(SELECT 1 FROM receipt_exports ce2
            WHERE ce2.status='draft' AND ce2.sealing_token IS NOT NULL
              AND ce2.sealing_expires_at IS NOT NULL
              AND ce2.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND ce2.export_month IN (SELECT asl.statement_month
                                       FROM amex_statement_lines asl
                                       WHERE asl.matched_receipt_id = OLD.id))
  OR EXISTS(SELECT 1 FROM receipt_exports ce3
            WHERE ce3.status='draft' AND ce3.sealing_token IS NOT NULL
              AND ce3.sealing_expires_at IS NOT NULL
              AND ce3.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND (ce3.export_month IS substr(NEW.transaction_date,1,7)
                   OR ce3.export_month IS NEW.export_statement_month
                   OR ce3.export_month IS NEW.exported_month))
  OR EXISTS(SELECT 1 FROM receipt_exports ce4
            WHERE ce4.status='draft' AND ce4.sealing_token IS NOT NULL
              AND ce4.sealing_expires_at IS NOT NULL
              AND ce4.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND ce4.export_month IN (SELECT asl2.statement_month
                                       FROM amex_statement_lines asl2
                                       WHERE asl2.matched_receipt_id = NEW.id))
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_records');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_receipt_insert
BEFORE INSERT ON receipt_records
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND (ce.export_month IS substr(NEW.transaction_date,1,7)
                   OR ce.export_month IS NEW.export_statement_month))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_records');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_receipt_delete
BEFORE DELETE ON receipt_records
WHEN (
  EXISTS(SELECT 1 FROM receipt_exports ce
         WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
           AND ce.sealing_expires_at IS NOT NULL
           AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
           AND (ce.export_month IS substr(OLD.transaction_date,1,7)
                OR ce.export_month IS OLD.export_statement_month
                OR ce.export_month IS OLD.exported_month))
  OR EXISTS(SELECT 1 FROM receipt_exports ce2
            WHERE ce2.status='draft' AND ce2.sealing_token IS NOT NULL
              AND ce2.sealing_expires_at IS NOT NULL
              AND ce2.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND ce2.export_month IN (SELECT asl.statement_month
                                       FROM amex_statement_lines asl
                                       WHERE asl.matched_receipt_id = OLD.id))
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_records');
END;

-- Post-publication: the canonical edit-lock semantics (export lock with ADR
-- 0012 draft carve-out, reconciliation lock via matched lines, archived
-- terminal, exported-receipt route rule) enforced at write time. Financial /
-- membership / scope columns only — processor counters, extraction_json and
-- preservation metadata stay outside permanent financial locks.
CREATE TRIGGER IF NOT EXISTS seal_lock_receipt_update
BEFORE UPDATE ON receipt_records
WHEN (
     OLD.payment_path IS NOT NEW.payment_path
  OR OLD.transaction_date IS NOT NEW.transaction_date
  OR OLD.export_statement_month IS NOT NEW.export_statement_month
  OR OLD.exported_month IS NOT NEW.exported_month
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.merchant IS NOT NEW.merchant
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.expense_category_code IS NOT NEW.expense_category_code
  OR OLD.business_purpose IS NOT NEW.business_purpose
  OR OLD.tax_rate IS NOT NEW.tax_rate
  OR OLD.tax_amount_minor IS NOT NEW.tax_amount_minor
  OR OLD.invoice_registration_number IS NOT NEW.invoice_registration_number
  OR OLD.qualified_invoice_status IS NOT NEW.qualified_invoice_status
  OR OLD.counterparty_name IS NOT NEW.counterparty_name
  OR OLD.source_type IS NOT NEW.source_type
  OR OLD.status IS NOT NEW.status
  OR OLD.original_r2_key IS NOT NEW.original_r2_key
  OR OLD.original_sha256 IS NOT NEW.original_sha256
  OR OLD.original_content_type IS NOT NEW.original_content_type
  OR OLD.original_size_bytes IS NOT NEW.original_size_bytes
)
AND (
  -- Archived payload is terminal.
  OLD.status = 'archived'
  -- Reconciliation lock: matched to a line in a finalized reconciliation whose
  -- statement month is export-locked (identical to
  -- rejectIfReceiptInFinalizedReconciliation + isMonthLockedForEdits).
  OR EXISTS(SELECT 1 FROM amex_statement_lines asl
            JOIN amex_reconciliations ar
              ON ar.statement_month = asl.statement_month AND ar.status='finalized'
            WHERE asl.matched_receipt_id = OLD.id
              AND EXISTS(SELECT 1 FROM receipt_exports fe
                         WHERE fe.status='finalized'
                           AND fe.export_month IS asl.statement_month)
              AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                             WHERE de.status='draft'
                               AND de.export_month IS asl.statement_month))
  -- Export lock, CASH/DIGITAL: effective (post-update) transaction month or
  -- stored membership must be open — covers moving OUT of and INTO a locked
  -- month, and clearing membership/date.
  OR ((NEW.payment_path='CASH' OR NEW.payment_path='DIGITAL') AND (
        (EXISTS(SELECT 1 FROM receipt_exports fe
                WHERE fe.status='finalized'
                  AND fe.export_month IS substr(NEW.transaction_date,1,7))
         AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                        WHERE de.status='draft'
                          AND de.export_month IS substr(NEW.transaction_date,1,7)))
     OR (NEW.export_statement_month IS NOT NULL
         AND EXISTS(SELECT 1 FROM receipt_exports fe
                    WHERE fe.status='finalized'
                      AND fe.export_month IS NEW.export_statement_month)
         AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                        WHERE de.status='draft'
                          AND de.export_month IS NEW.export_statement_month))))
  -- Exported receipt route rule: an 'exported' row is editable only under the
  -- open-draft carve-out of its exported_month.
  OR (OLD.status='exported' AND OLD.exported_month IS NOT NULL
      AND EXISTS(SELECT 1 FROM receipt_exports fe
                 WHERE fe.status='finalized' AND fe.export_month IS OLD.exported_month)
      AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                     WHERE de.status='draft' AND de.export_month IS OLD.exported_month))
  -- Moving INTO an export-locked month as an exported receipt is not a thing;
  -- but a CASH/DIGITAL row moving in via OLD-side state is covered above.
)
AND NOT (
  -- Admitted promotion (finalizeExport's exact shape): only lifecycle fields
  -- change, the row leaves a pre-export status, and the receiving export is
  -- FINALIZED with this receipt in its published item set. Evaluated inside
  -- the publication transaction, so the just-written items justify it.
  NEW.status = 'exported'
  AND OLD.status IN ('captured','needs_review','reviewed','reconciled')
  AND NEW.payment_path IS OLD.payment_path
  AND NEW.transaction_date IS OLD.transaction_date
  AND NEW.export_statement_month IS OLD.export_statement_month
  AND NEW.merchant IS OLD.merchant
  AND NEW.amount_minor IS OLD.amount_minor
  AND NEW.currency IS OLD.currency
  AND NEW.expense_category_code IS OLD.expense_category_code
  AND NEW.business_purpose IS OLD.business_purpose
  AND NEW.tax_rate IS OLD.tax_rate
  AND NEW.tax_amount_minor IS OLD.tax_amount_minor
  AND NEW.invoice_registration_number IS OLD.invoice_registration_number
  AND NEW.qualified_invoice_status IS OLD.qualified_invoice_status
  AND NEW.counterparty_name IS OLD.counterparty_name
  AND NEW.source_type IS OLD.source_type
  AND NEW.original_r2_key IS OLD.original_r2_key
  AND NEW.original_sha256 IS OLD.original_sha256
  AND NEW.original_content_type IS OLD.original_content_type
  AND NEW.original_size_bytes IS OLD.original_size_bytes
  AND NEW.deleted_at IS OLD.deleted_at
  AND EXISTS(SELECT 1 FROM receipt_export_items i
             JOIN receipt_exports e ON e.id = i.export_id
             WHERE i.item_type='receipt' AND i.item_id IS OLD.id
               AND e.status='finalized' AND e.export_month IS NEW.exported_month)
)
AND NOT (
  -- Permitted archive maintenance: exported -> archived with lifecycle/preservation
  -- fields only, accounting/membership/original values unchanged, no deletion.
  OLD.status='exported' AND NEW.status='archived'
  AND NEW.payment_path IS OLD.payment_path
  AND NEW.transaction_date IS OLD.transaction_date
  AND NEW.export_statement_month IS OLD.export_statement_month
  AND NEW.exported_month IS OLD.exported_month
  AND NEW.merchant IS OLD.merchant
  AND NEW.amount_minor IS OLD.amount_minor
  AND NEW.currency IS OLD.currency
  AND NEW.expense_category_code IS OLD.expense_category_code
  AND NEW.business_purpose IS OLD.business_purpose
  AND NEW.tax_rate IS OLD.tax_rate
  AND NEW.tax_amount_minor IS OLD.tax_amount_minor
  AND NEW.invoice_registration_number IS OLD.invoice_registration_number
  AND NEW.qualified_invoice_status IS OLD.qualified_invoice_status
  AND NEW.counterparty_name IS OLD.counterparty_name
  AND NEW.source_type IS OLD.source_type
  AND NEW.original_r2_key IS OLD.original_r2_key
  AND NEW.original_sha256 IS OLD.original_sha256
  AND NEW.original_content_type IS OLD.original_content_type
  AND NEW.original_size_bytes IS OLD.original_size_bytes
  AND NEW.deleted_at IS OLD.deleted_at
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_MONTH_LOCKED:receipt_records');
END;

-- Post-publication INSERT: a CASH/DIGITAL receipt cannot be inserted with a
-- date (or membership) landing in an export-locked month (mirrors
-- assertTransactionMonthEditable at capture).
CREATE TRIGGER IF NOT EXISTS seal_lock_receipt_insert
BEFORE INSERT ON receipt_records
WHEN (NEW.payment_path='CASH' OR NEW.payment_path='DIGITAL')
AND (
  (EXISTS(SELECT 1 FROM receipt_exports fe
          WHERE fe.status='finalized' AND fe.export_month IS substr(NEW.transaction_date,1,7))
   AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                  WHERE de.status='draft' AND de.export_month IS substr(NEW.transaction_date,1,7)))
  OR (NEW.export_statement_month IS NOT NULL
      AND EXISTS(SELECT 1 FROM receipt_exports fe
                 WHERE fe.status='finalized' AND fe.export_month IS NEW.export_statement_month)
      AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                     WHERE de.status='draft' AND de.export_month IS NEW.export_statement_month))
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_MONTH_LOCKED:receipt_records');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_receipt_delete
BEFORE DELETE ON receipt_records
WHEN (
  OLD.status = 'archived'
  OR EXISTS(SELECT 1 FROM amex_statement_lines asl
            JOIN amex_reconciliations ar
              ON ar.statement_month = asl.statement_month AND ar.status='finalized'
            WHERE asl.matched_receipt_id = OLD.id
              AND EXISTS(SELECT 1 FROM receipt_exports fe
                         WHERE fe.status='finalized'
                           AND fe.export_month IS asl.statement_month)
              AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                             WHERE de.status='draft'
                               AND de.export_month IS asl.statement_month))
  OR ((OLD.payment_path='CASH' OR OLD.payment_path='DIGITAL') AND (
        (EXISTS(SELECT 1 FROM receipt_exports fe
                WHERE fe.status='finalized'
                  AND fe.export_month IS substr(OLD.transaction_date,1,7))
         AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                        WHERE de.status='draft'
                          AND de.export_month IS substr(OLD.transaction_date,1,7)))
     OR (OLD.export_statement_month IS NOT NULL
         AND EXISTS(SELECT 1 FROM receipt_exports fe
                    WHERE fe.status='finalized'
                      AND fe.export_month IS OLD.export_statement_month)
         AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                        WHERE de.status='draft'
                          AND de.export_month IS OLD.export_statement_month))))
  OR (OLD.status='exported' AND OLD.exported_month IS NOT NULL
      AND EXISTS(SELECT 1 FROM receipt_exports fe
                 WHERE fe.status='finalized' AND fe.export_month IS OLD.exported_month)
      AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                     WHERE de.status='draft' AND de.export_month IS OLD.exported_month))
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_MONTH_LOCKED:receipt_records');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- receipt_attendees — same authority as their parent receipt, all events,
-- including direct deletes. Parent guards handle cascade contexts.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_claim_attendee_insert
BEFORE INSERT ON receipt_attendees
WHEN EXISTS(
  SELECT 1 FROM receipt_records r
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND (ce.export_month IS substr(r.transaction_date,1,7)
         OR ce.export_month IS r.export_statement_month
         OR ce.export_month IS r.exported_month
         OR ce.export_month IN (SELECT asl.statement_month FROM amex_statement_lines asl
                                WHERE asl.matched_receipt_id = r.id))
  WHERE r.id = NEW.receipt_id
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_attendees');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_attendee_update
BEFORE UPDATE ON receipt_attendees
WHEN EXISTS(
  SELECT 1 FROM receipt_records r
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND (ce.export_month IS substr(r.transaction_date,1,7)
         OR ce.export_month IS r.export_statement_month
         OR ce.export_month IS r.exported_month
         OR ce.export_month IN (SELECT asl.statement_month FROM amex_statement_lines asl
                                WHERE asl.matched_receipt_id = r.id))
  WHERE r.id IN (OLD.receipt_id, NEW.receipt_id)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_attendees');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_attendee_delete
BEFORE DELETE ON receipt_attendees
WHEN EXISTS(
  SELECT 1 FROM receipt_records r
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND (ce.export_month IS substr(r.transaction_date,1,7)
         OR ce.export_month IS r.export_statement_month
         OR ce.export_month IS r.exported_month
         OR ce.export_month IN (SELECT asl.statement_month FROM amex_statement_lines asl
                                WHERE asl.matched_receipt_id = r.id))
  WHERE r.id = OLD.receipt_id
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_attendees');
END;

-- Post-publication: parent receipt's edit authority (draft carve-out applies).
CREATE TRIGGER IF NOT EXISTS seal_lock_attendee_insert
BEFORE INSERT ON receipt_attendees
WHEN EXISTS(
  SELECT 1 FROM receipt_records r
  WHERE r.id = NEW.receipt_id
    AND (r.status = 'archived'
     OR EXISTS(SELECT 1 FROM amex_statement_lines asl
               JOIN amex_reconciliations ar
                 ON ar.statement_month = asl.statement_month AND ar.status='finalized'
               WHERE asl.matched_receipt_id = r.id
                 AND EXISTS(SELECT 1 FROM receipt_exports fe
                            WHERE fe.status='finalized'
                              AND fe.export_month IS asl.statement_month)
                 AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                                WHERE de.status='draft'
                                  AND de.export_month IS asl.statement_month))
     OR ((r.payment_path='CASH' OR r.payment_path='DIGITAL') AND (
           (EXISTS(SELECT 1 FROM receipt_exports fe
                   WHERE fe.status='finalized'
                     AND fe.export_month IS substr(r.transaction_date,1,7))
            AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                           WHERE de.status='draft'
                             AND de.export_month IS substr(r.transaction_date,1,7)))
        OR (r.export_statement_month IS NOT NULL
            AND EXISTS(SELECT 1 FROM receipt_exports fe
                       WHERE fe.status='finalized'
                         AND fe.export_month IS r.export_statement_month)
            AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                           WHERE de.status='draft'
                             AND de.export_month IS r.export_statement_month))))
     OR (r.status='exported' AND r.exported_month IS NOT NULL
         AND EXISTS(SELECT 1 FROM receipt_exports fe
                    WHERE fe.status='finalized' AND fe.export_month IS r.exported_month)
         AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                        WHERE de.status='draft' AND de.export_month IS r.exported_month)))
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_MONTH_LOCKED:receipt_attendees');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_attendee_delete
BEFORE DELETE ON receipt_attendees
WHEN EXISTS(
  SELECT 1 FROM receipt_records r
  WHERE r.id = OLD.receipt_id
    AND (r.status = 'archived'
     OR EXISTS(SELECT 1 FROM amex_statement_lines asl
               JOIN amex_reconciliations ar
                 ON ar.statement_month = asl.statement_month AND ar.status='finalized'
               WHERE asl.matched_receipt_id = r.id
                 AND EXISTS(SELECT 1 FROM receipt_exports fe
                            WHERE fe.status='finalized'
                              AND fe.export_month IS asl.statement_month)
                 AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                                WHERE de.status='draft'
                                  AND de.export_month IS asl.statement_month))
     OR ((r.payment_path='CASH' OR r.payment_path='DIGITAL') AND (
           (EXISTS(SELECT 1 FROM receipt_exports fe
                   WHERE fe.status='finalized'
                     AND fe.export_month IS substr(r.transaction_date,1,7))
            AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                           WHERE de.status='draft'
                             AND de.export_month IS substr(r.transaction_date,1,7)))
        OR (r.export_statement_month IS NOT NULL
            AND EXISTS(SELECT 1 FROM receipt_exports fe
                       WHERE fe.status='finalized'
                         AND fe.export_month IS r.export_statement_month)
            AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                           WHERE de.status='draft'
                             AND de.export_month IS r.export_statement_month))))
     OR (r.status='exported' AND r.exported_month IS NOT NULL
         AND EXISTS(SELECT 1 FROM receipt_exports fe
                    WHERE fe.status='finalized' AND fe.export_month IS r.exported_month)
         AND NOT EXISTS(SELECT 1 FROM receipt_exports de
                        WHERE de.status='draft' AND de.export_month IS r.exported_month)))
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_MONTH_LOCKED:receipt_attendees');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- attendee_directory — shared global directory; conservatively fenced against
-- ANY active build claim (brief global conflict accepted by the contract).
-- Edits remain allowed after publication: future builds resolve the current
-- directory, sealed CSVs carry their snapshotted rows.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_claim_directory_insert
BEFORE INSERT ON attendee_directory
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:attendee_directory');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_directory_update
BEFORE UPDATE ON attendee_directory
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:attendee_directory');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_directory_delete
BEFORE DELETE ON attendee_directory
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:attendee_directory');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- amex_statement_lines
-- ═══════════════════════════════════════════════════════════════════════════

-- Active claim: both OLD/NEW statement months, plus cross-month claims —
-- re-pointing a line's matched_receipt_id at (or away from) a receipt fenced
-- by a claimed month changes that month's gate even when the line's own month
-- is open. Includes matched-receipt mutations and ALL meaningful payload
-- columns, not only fields in M.
CREATE TRIGGER IF NOT EXISTS seal_claim_line_update
BEFORE UPDATE ON amex_statement_lines
WHEN (
     OLD.statement_month IS NOT NEW.statement_month
  OR OLD.matched_receipt_id IS NOT NEW.matched_receipt_id
  OR OLD.match_status IS NOT NEW.match_status
  OR OLD.receipt_status IS NOT NEW.receipt_status
  or OLD.receipt_missing_reason IS NOT NEW.receipt_missing_reason
  OR OLD.transaction_date IS NOT NEW.transaction_date
  OR OLD.merchant IS NOT NEW.merchant
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.expense_category IS NOT NEW.expense_category
  OR OLD.category_status IS NOT NEW.category_status
  OR OLD.expense_category_code IS NOT NEW.expense_category_code
  OR OLD.cardholder_name IS NOT NEW.cardholder_name
  OR OLD.business_trip_id IS NOT NEW.business_trip_id
  OR OLD.business_trip_status IS NOT NEW.business_trip_status
  OR OLD.re_review_needed IS NOT NEW.re_review_needed
  OR OLD.raw_csv_line_number IS NOT NEW.raw_csv_line_number
  OR OLD.statement_artifact_id IS NOT NEW.statement_artifact_id
  OR OLD.source_file_sha256 IS NOT NEW.source_file_sha256
  OR OLD.raw_json IS NOT NEW.raw_json
  OR OLD.amex_reference IS NOT NEW.amex_reference
)
AND (
  EXISTS(SELECT 1 FROM receipt_exports ce
         WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
           AND ce.sealing_expires_at IS NOT NULL
           AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
           AND (ce.export_month IS OLD.statement_month
                OR ce.export_month IS NEW.statement_month))
  -- Cross-month: the OLD or NEW matched receipt is fenced by a claim via its
  -- own membership/calendar scope or via a DIFFERENT line's statement month.
  OR EXISTS(SELECT 1 FROM receipt_records r
            JOIN receipt_exports ce2 ON ce2.status='draft' AND ce2.sealing_token IS NOT NULL
              AND ce2.sealing_expires_at IS NOT NULL
              AND ce2.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND (ce2.export_month IS substr(r.transaction_date,1,7)
                   OR ce2.export_month IS r.export_statement_month
                   OR ce2.export_month IS r.exported_month
                   OR ce2.export_month IN (SELECT asl.statement_month
                                            FROM amex_statement_lines asl
                                            WHERE asl.matched_receipt_id = r.id
                                              AND asl.id IS NOT OLD.id))
            WHERE r.id IN (OLD.matched_receipt_id, NEW.matched_receipt_id))
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_statement_lines');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_line_insert
BEFORE INSERT ON amex_statement_lines
WHEN (
  EXISTS(SELECT 1 FROM receipt_exports ce
         WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
           AND ce.sealing_expires_at IS NOT NULL
           AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
           AND ce.export_month IS NEW.statement_month)
  OR EXISTS(SELECT 1 FROM receipt_records r
            JOIN receipt_exports ce2 ON ce2.status='draft' AND ce2.sealing_token IS NOT NULL
              AND ce2.sealing_expires_at IS NOT NULL
              AND ce2.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND (ce2.export_month IS substr(r.transaction_date,1,7)
                   OR ce2.export_month IS r.export_statement_month
                   OR ce2.export_month IS r.exported_month
                   OR ce2.export_month IN (SELECT asl.statement_month
                                            FROM amex_statement_lines asl
                                            WHERE asl.matched_receipt_id = r.id))
            WHERE r.id IS NEW.matched_receipt_id)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_statement_lines');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_line_delete
BEFORE DELETE ON amex_statement_lines
WHEN (
  EXISTS(SELECT 1 FROM receipt_exports ce
         WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
           AND ce.sealing_expires_at IS NOT NULL
           AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
           AND ce.export_month IS OLD.statement_month)
  OR EXISTS(SELECT 1 FROM receipt_records r
            JOIN receipt_exports ce2 ON ce2.status='draft' AND ce2.sealing_token IS NOT NULL
              AND ce2.sealing_expires_at IS NOT NULL
              AND ce2.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND (ce2.export_month IS substr(r.transaction_date,1,7)
                   OR ce2.export_month IS r.export_statement_month
                   OR ce2.export_month IS r.exported_month
                   OR ce2.export_month IN (SELECT asl.statement_month
                                            FROM amex_statement_lines asl
                                            WHERE asl.matched_receipt_id = r.id
                                              AND asl.id IS NOT OLD.id))
            WHERE r.id IS OLD.matched_receipt_id)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_statement_lines');
END;

-- Post-publication: strict finalized-reconciliation seal for OLD/NEW statement
-- months — NO export-draft carve-out (a format-only revision must not reopen
-- match assignments). Mirrors rejectIfFinalized at write time.
CREATE TRIGGER IF NOT EXISTS seal_lock_line_update
BEFORE UPDATE ON amex_statement_lines
WHEN EXISTS(
  SELECT 1 FROM amex_reconciliations ar
  WHERE ar.status='finalized'
    AND (ar.statement_month IS OLD.statement_month
         OR ar.statement_month IS NEW.statement_month)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_RECON_LOCKED:amex_statement_lines');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_line_insert
BEFORE INSERT ON amex_statement_lines
WHEN EXISTS(
  SELECT 1 FROM amex_reconciliations ar
  WHERE ar.status='finalized' AND ar.statement_month IS NEW.statement_month
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_RECON_LOCKED:amex_statement_lines');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_line_delete
BEFORE DELETE ON amex_statement_lines
WHEN EXISTS(
  SELECT 1 FROM amex_reconciliations ar
  WHERE ar.status='finalized' AND ar.statement_month IS OLD.statement_month
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_RECON_LOCKED:amex_statement_lines');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- amex_line_attendees — both parent-line scopes, all events; strict line
-- reconciliation authority after publication (no draft carve-out).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_claim_line_attendee_insert
BEFORE INSERT ON amex_line_attendees
WHEN EXISTS(
  SELECT 1 FROM amex_statement_lines l
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND ce.export_month IS l.statement_month
  WHERE l.id = NEW.amex_statement_line_id
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_line_attendees');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_line_attendee_update
BEFORE UPDATE ON amex_line_attendees
WHEN EXISTS(
  SELECT 1 FROM amex_statement_lines l
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND ce.export_month IS l.statement_month
  WHERE l.id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_line_attendees');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_line_attendee_delete
BEFORE DELETE ON amex_line_attendees
WHEN EXISTS(
  SELECT 1 FROM amex_statement_lines l
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND ce.export_month IS l.statement_month
  WHERE l.id = OLD.amex_statement_line_id
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_line_attendees');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_line_attendee_insert
BEFORE INSERT ON amex_line_attendees
WHEN EXISTS(
  SELECT 1 FROM amex_statement_lines l
  JOIN amex_reconciliations ar
    ON ar.statement_month = l.statement_month AND ar.status='finalized'
  WHERE l.id = NEW.amex_statement_line_id
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_RECON_LOCKED:amex_line_attendees');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_line_attendee_update
BEFORE UPDATE ON amex_line_attendees
WHEN EXISTS(
  SELECT 1 FROM amex_statement_lines l
  JOIN amex_reconciliations ar
    ON ar.statement_month = l.statement_month AND ar.status='finalized'
  WHERE l.id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_RECON_LOCKED:amex_line_attendees');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_line_attendee_delete
BEFORE DELETE ON amex_line_attendees
WHEN EXISTS(
  SELECT 1 FROM amex_statement_lines l
  JOIN amex_reconciliations ar
    ON ar.statement_month = l.statement_month AND ar.status='finalized'
  WHERE l.id = OLD.amex_statement_line_id
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_RECON_LOCKED:amex_line_attendees');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- amex_statement_artifacts — freeze selection-relevant fields under a claim;
-- after publication, identity fields of artifacts retained by a prior seal are
-- immutable (the sealed manifest names key/hash/filename; the finalized
-- reconciliation anchors selection). import_status bookkeeping (replacement)
-- stays writable so the existing replace flow keeps working while originals
-- are retained.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_claim_artifact_update
BEFORE UPDATE ON amex_statement_artifacts
WHEN (
     OLD.statement_month IS NOT NEW.statement_month
  OR OLD.r2_key IS NOT NEW.r2_key
  OR OLD.sha256_hash IS NOT NEW.sha256_hash
  OR OLD.original_filename IS NOT NEW.original_filename
  OR OLD.payment_due_date IS NOT NEW.payment_due_date
  OR OLD.import_status IS NOT NEW.import_status
  OR OLD.row_count IS NOT NEW.row_count
  OR OLD.transaction_count IS NOT NEW.transaction_count
  OR OLD.file_size_bytes IS NOT NEW.file_size_bytes
)
AND EXISTS(SELECT 1 FROM receipt_exports ce
           WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
             AND ce.sealing_expires_at IS NOT NULL
             AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
             AND (ce.export_month IS OLD.statement_month
                  OR ce.export_month IS NEW.statement_month))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_statement_artifacts');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_artifact_insert
BEFORE INSERT ON amex_statement_artifacts
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND ce.export_month IS NEW.statement_month)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_statement_artifacts');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_artifact_delete
BEFORE DELETE ON amex_statement_artifacts
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND ce.export_month IS OLD.statement_month)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_statement_artifacts');
END;

-- Post-publication: identity of a seal-retained artifact is immutable, and the
-- row is undeletable. Retained = anchored by a FINALIZED reconciliation
-- (statement_artifact_id) OR its statement month has a finalized export (the
-- pack snapshotted its payment-due date and manifest hashes). Unfinalizing the
-- reconciliation does NOT release finalized-export payload protection.
CREATE TRIGGER IF NOT EXISTS seal_lock_artifact_update
BEFORE UPDATE ON amex_statement_artifacts
WHEN (
     OLD.r2_key IS NOT NEW.r2_key
  OR OLD.sha256_hash IS NOT NEW.sha256_hash
  OR OLD.original_filename IS NOT NEW.original_filename
  OR OLD.payment_due_date IS NOT NEW.payment_due_date
  OR OLD.file_size_bytes IS NOT NEW.file_size_bytes
  OR OLD.statement_month IS NOT NEW.statement_month
)
AND (
  EXISTS(SELECT 1 FROM amex_reconciliations ar
         WHERE ar.statement_artifact_id IS OLD.id AND ar.status='finalized')
  OR EXISTS(SELECT 1 FROM receipt_exports fe
            WHERE fe.status='finalized' AND fe.export_month IS OLD.statement_month)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_ARTIFACT_RETAINED:amex_statement_artifacts');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_artifact_delete
BEFORE DELETE ON amex_statement_artifacts
WHEN (
  EXISTS(SELECT 1 FROM amex_reconciliations ar
         WHERE ar.statement_artifact_id IS OLD.id AND ar.status='finalized')
  OR EXISTS(SELECT 1 FROM receipt_exports fe
            WHERE fe.status='finalized' AND fe.export_month IS OLD.statement_month)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_ARTIFACT_RETAINED:amex_statement_artifacts');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- amex_reconciliations — frozen under a claim (both months, all events, incl.
-- the selected anchor). After publication, a FINALIZED row is immutable except
-- the explicit unfinalize shape (db.ts unfinalizeReconciliation), which is NOT
-- an implicit release of finalized export payload protection elsewhere.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_claim_reconciliation_update
BEFORE UPDATE ON amex_reconciliations
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND (ce.export_month IS OLD.statement_month
                   OR ce.export_month IS NEW.statement_month))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_reconciliations');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_reconciliation_insert
BEFORE INSERT ON amex_reconciliations
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND ce.export_month IS NEW.statement_month)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_reconciliations');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_reconciliation_delete
BEFORE DELETE ON amex_reconciliations
WHEN EXISTS(SELECT 1 FROM receipt_exports ce
            WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
              AND ce.sealing_expires_at IS NOT NULL
              AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
              AND ce.export_month IS OLD.statement_month)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:amex_reconciliations');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_reconciliation_update
BEFORE UPDATE ON amex_reconciliations
WHEN OLD.status='finalized'
AND NOT (
  -- Explicit unfinalize: exactly status/finalized_by/finalized_at change.
  NEW.status='draft'
  AND NEW.finalized_by IS NULL
  AND NEW.finalized_at IS NULL
  AND NEW.statement_month IS OLD.statement_month
  AND NEW.statement_artifact_id IS OLD.statement_artifact_id
  AND NEW.manifest_r2_key IS OLD.manifest_r2_key
  AND NEW.manifest_sha256 IS OLD.manifest_sha256
  AND NEW.line_count IS OLD.line_count
  AND NEW.matched_count IS OLD.matched_count
  AND NEW.no_receipt_count IS OLD.no_receipt_count
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_RECON_LOCKED:amex_reconciliations');
END;

CREATE TRIGGER IF NOT EXISTS seal_lock_reconciliation_delete
BEFORE DELETE ON amex_reconciliations
WHEN OLD.status='finalized'
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_RECON_LOCKED:amex_reconciliations');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- receipt_files — polymorphic (object_type/object_id), no parent FK. Under a
-- claim: both OLD/NEW object scopes, all manifest fields, all roles. After
-- publication: NO strict lock — current-manifest replacement with immutable
-- new versioned keys and retained old bytes is legitimate (backfill); sealed
-- manifests are R2 CSVs that are never rewritten.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_claim_file_insert
BEFORE INSERT ON receipt_files
WHEN EXISTS(
  SELECT 1 FROM receipt_records r
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND (ce.export_month IS substr(r.transaction_date,1,7)
         OR ce.export_month IS r.export_statement_month
         OR ce.export_month IS r.exported_month
         OR ce.export_month IN (SELECT asl.statement_month FROM amex_statement_lines asl
                                WHERE asl.matched_receipt_id = r.id))
  WHERE NEW.object_type='receipt' AND r.id = NEW.object_id
)
OR EXISTS(
  SELECT 1 FROM amex_statement_artifacts a
  JOIN receipt_exports ce2 ON ce2.status='draft' AND ce2.sealing_token IS NOT NULL
    AND ce2.sealing_expires_at IS NOT NULL
    AND ce2.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND ce2.export_month IS a.statement_month
  WHERE NEW.object_type='amex_statement_artifact' AND a.id = NEW.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_files');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_file_update
BEFORE UPDATE ON receipt_files
WHEN EXISTS(
  SELECT 1 FROM receipt_records r
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND (ce.export_month IS substr(r.transaction_date,1,7)
         OR ce.export_month IS r.export_statement_month
         OR ce.export_month IS r.exported_month
         OR ce.export_month IN (SELECT asl.statement_month FROM amex_statement_lines asl
                                WHERE asl.matched_receipt_id = r.id))
  WHERE OLD.object_type='receipt' AND r.id IN (OLD.object_id, NEW.object_id)
)
OR EXISTS(
  SELECT 1 FROM receipt_records r
  JOIN receipt_exports ce3 ON ce3.status='draft' AND ce3.sealing_token IS NOT NULL
    AND ce3.sealing_expires_at IS NOT NULL
    AND ce3.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND (ce3.export_month IS substr(r.transaction_date,1,7)
         OR ce3.export_month IS r.export_statement_month
         OR ce3.export_month IS r.exported_month
         OR ce3.export_month IN (SELECT asl.statement_month FROM amex_statement_lines asl
                                 WHERE asl.matched_receipt_id = r.id))
  WHERE NEW.object_type='receipt' AND r.id = NEW.object_id
)
OR EXISTS(
  SELECT 1 FROM amex_statement_artifacts a
  JOIN receipt_exports ce4 ON ce4.status='draft' AND ce4.sealing_token IS NOT NULL
    AND ce4.sealing_expires_at IS NOT NULL
    AND ce4.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND ce4.export_month IS a.statement_month
  WHERE OLD.object_type='amex_statement_artifact'
    AND a.id IN (OLD.object_id, NEW.object_id)
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_files');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_file_delete
BEFORE DELETE ON receipt_files
WHEN EXISTS(
  SELECT 1 FROM receipt_records r
  JOIN receipt_exports ce ON ce.status='draft' AND ce.sealing_token IS NOT NULL
    AND ce.sealing_expires_at IS NOT NULL
    AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND (ce.export_month IS substr(r.transaction_date,1,7)
         OR ce.export_month IS r.export_statement_month
         OR ce.export_month IS r.exported_month
         OR ce.export_month IN (SELECT asl.statement_month FROM amex_statement_lines asl
                                WHERE asl.matched_receipt_id = r.id))
  WHERE OLD.object_type='receipt' AND r.id = OLD.object_id
)
OR EXISTS(
  SELECT 1 FROM amex_statement_artifacts a
  JOIN receipt_exports ce2 ON ce2.status='draft' AND ce2.sealing_token IS NOT NULL
    AND ce2.sealing_expires_at IS NOT NULL
    AND ce2.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
    AND ce2.export_month IS a.statement_month
  WHERE OLD.object_type='amex_statement_artifact' AND a.id = OLD.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_files');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- receipt_settings — the five gate-relevant keys freeze under ANY active
-- claim. Normal config edits stay allowed after publication (old pack bytes
-- are never rewritten from settings).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_claim_setting_insert
BEFORE INSERT ON receipt_settings
WHEN NEW.key IN ('require_attendees_for_meeting',
                 'require_attendees_for_entertainment',
                 'invoice_number_requirement_mode',
                 'track_tax_breakdown',
                 'export_block_on_warnings')
AND EXISTS(SELECT 1 FROM receipt_exports ce
           WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
             AND ce.sealing_expires_at IS NOT NULL
             AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_settings');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_setting_update
BEFORE UPDATE ON receipt_settings
WHEN (OLD.key IN ('require_attendees_for_meeting',
                  'require_attendees_for_entertainment',
                  'invoice_number_requirement_mode',
                  'track_tax_breakdown',
                  'export_block_on_warnings')
      OR NEW.key IN ('require_attendees_for_meeting',
                     'require_attendees_for_entertainment',
                     'invoice_number_requirement_mode',
                     'track_tax_breakdown',
                     'export_block_on_warnings'))
AND EXISTS(SELECT 1 FROM receipt_exports ce
           WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
             AND ce.sealing_expires_at IS NOT NULL
             AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_settings');
END;

CREATE TRIGGER IF NOT EXISTS seal_claim_setting_delete
BEFORE DELETE ON receipt_settings
WHEN OLD.key IN ('require_attendees_for_meeting',
                 'require_attendees_for_entertainment',
                 'invoice_number_requirement_mode',
                 'track_tax_breakdown',
                 'export_block_on_warnings')
AND EXISTS(SELECT 1 FROM receipt_exports ce
           WHERE ce.status='draft' AND ce.sealing_token IS NOT NULL
             AND ce.sealing_expires_at IS NOT NULL
             AND ce.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER))
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_CLAIM_ACTIVE:receipt_settings');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- receipt_exports — claim transitions and sealed-row immutability.
--
-- While a claim is ACTIVE on the row (OLD lease unexpired):
--   * identity (month/revision/supersession/correction reason), status, the
--     stored message value AND its decision timestamp are fenced — external
--     message mutation is rejected;
--   * EXCEPT the owned transitions:
--       (a) publication — NEW.bundle_build_id = OLD.sealing_token, claim
--           cleared, decision timestamp unchanged (status may flip to
--           finalized; message value may carry the rebuild's override);
--       (b) conditional release — claim cleared, nothing else changes.
-- Acquiring over an ABSENT/EXPIRED claim is unrestricted (guard requires an
-- active OLD claim), which is also how the finalize decision write rides the
-- acquisition statement.
--
-- After publication (OLD.status='finalized'), sealed artifact fields / build
-- id / message / revision identity are immutable; delivery columns
-- (delivery_state) and retention metadata (retention_until, legal_hold) may
-- still change.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_export_claim_update
BEFORE UPDATE ON receipt_exports
WHEN (
  OLD.sealing_token IS NOT NULL
  AND OLD.sealing_expires_at IS NOT NULL
  AND OLD.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
)
AND (
     OLD.sealing_token IS NOT NEW.sealing_token
  OR OLD.sealing_expires_at IS NOT NEW.sealing_expires_at
  OR OLD.operator_message IS NOT NEW.operator_message
  OR OLD.operator_message_updated_at IS NOT NEW.operator_message_updated_at
  OR OLD.export_month IS NOT NEW.export_month
  OR OLD.export_revision IS NOT NEW.export_revision
  OR OLD.supersedes_export_id IS NOT NEW.supersedes_export_id
  OR OLD.correction_reason IS NOT NEW.correction_reason
  OR OLD.status IS NOT NEW.status
  OR OLD.bundle_build_id IS NOT NEW.bundle_build_id
)
AND NOT (
  -- (a) owned publication: the winning build stores its id and clears its own
  -- claim; the message VALUE may change (rebuild override) but the decision
  -- timestamp may not.
  NEW.sealing_token IS NULL
  AND NEW.sealing_expires_at IS NULL
  AND NEW.bundle_build_id = OLD.sealing_token
  AND NEW.operator_message_updated_at IS OLD.operator_message_updated_at
  AND NEW.export_month IS OLD.export_month
  AND NEW.export_revision IS OLD.export_revision
  AND NEW.supersedes_export_id IS OLD.supersedes_export_id
  AND NEW.correction_reason IS OLD.correction_reason
)
AND NOT (
  -- (b) owned conditional release: clears the claim, touches nothing else.
  NEW.sealing_token IS NULL
  AND NEW.sealing_expires_at IS NULL
  AND NEW.bundle_build_id IS OLD.bundle_build_id
  AND NEW.operator_message IS OLD.operator_message
  AND NEW.operator_message_updated_at IS OLD.operator_message_updated_at
  AND NEW.export_month IS OLD.export_month
  AND NEW.export_revision IS OLD.export_revision
  AND NEW.supersedes_export_id IS OLD.supersedes_export_id
  AND NEW.correction_reason IS OLD.correction_reason
  AND NEW.status IS OLD.status
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_EXPORT_CLAIM:receipt_exports');
END;

CREATE TRIGGER IF NOT EXISTS seal_export_sealed_update
BEFORE UPDATE ON receipt_exports
WHEN OLD.status='finalized'
AND (
     OLD.status IS NOT NEW.status
  OR OLD.archive_r2_key IS NOT NEW.archive_r2_key
  OR OLD.manifest_r2_key IS NOT NEW.manifest_r2_key
  OR OLD.archive_sha256 IS NOT NEW.archive_sha256
  OR OLD.manifest_sha256 IS NOT NEW.manifest_sha256
  OR OLD.proofs_r2_key IS NOT NEW.proofs_r2_key
  OR OLD.proofs_sha256 IS NOT NEW.proofs_sha256
  OR OLD.bundle_build_id IS NOT NEW.bundle_build_id
  OR OLD.bundle_built_at IS NOT NEW.bundle_built_at
  OR OLD.operator_message IS NOT NEW.operator_message
  OR OLD.operator_message_updated_at IS NOT NEW.operator_message_updated_at
  OR OLD.payment_due_date IS NOT NEW.payment_due_date
  OR OLD.export_month IS NOT NEW.export_month
  OR OLD.export_revision IS NOT NEW.export_revision
  OR OLD.supersedes_export_id IS NOT NEW.supersedes_export_id
  OR OLD.correction_reason IS NOT NEW.correction_reason
  OR OLD.finalization_hash IS NOT NEW.finalization_hash
  OR OLD.finalized_by IS NOT NEW.finalized_by
  OR OLD.finalized_at IS NOT NEW.finalized_at
)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_EXPORT_SEALED:receipt_exports');
END;

-- A draft holding an ACTIVE claim cannot be deleted (the claim is the fence;
-- the builder may still be staging objects).
CREATE TRIGGER IF NOT EXISTS seal_export_claim_delete
BEFORE DELETE ON receipt_exports
WHEN OLD.sealing_token IS NOT NULL
 AND OLD.sealing_expires_at IS NOT NULL
 AND OLD.sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_EXPORT_CLAIM:receipt_exports');
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- receipt_export_items — publication-only output. No active-claim trigger: the
-- owned publication batch replaces the draft's item set INSIDE the transaction
-- before the claim clears. After the parent seals, independent edits of the
-- finalized item set are prohibited (INSERT/UPDATE); deletion remains owned by
-- the parent row's authorized deletion path (0017 FK cascade), which has its
-- own committed planner/refusals (export-deletion.ts).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS seal_items_insert
BEFORE INSERT ON receipt_export_items
WHEN EXISTS(SELECT 1 FROM receipt_exports e
            WHERE e.id = NEW.export_id AND e.status='finalized')
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_ITEMS_FROZEN:receipt_export_items');
END;

CREATE TRIGGER IF NOT EXISTS seal_items_update
BEFORE UPDATE ON receipt_export_items
WHEN EXISTS(SELECT 1 FROM receipt_exports e
            WHERE e.id IN (OLD.export_id, NEW.export_id) AND e.status='finalized')
BEGIN
  SELECT RAISE(ABORT, 'DZ_SEAL_ITEMS_FROZEN:receipt_export_items');
END;
