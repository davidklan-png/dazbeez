-- Backfill invoice_registration_number from extraction_json.
--
-- WHY: all receipts extracted before the dbe4d79 (2026-06-09) worker deploy
-- had their インボイス登録番号 parsed into extraction_json but never written to
-- the queryable column (the extract route gained the column write later).
-- Verified 2026-07-08: 22 of 62 receipts affected, all with format-valid
-- T+13-digit values.
--
-- SCOPE: invoice number ONLY. taxAmountMinor / taxRate in extraction_json
-- contain model junk on some rows (e.g. taxRate 58.66) — do NOT backfill
-- those blindly; they should re-enter via the guarded re-parse path.
--
-- Idempotent: only fills NULL columns; guarded to T-prefixed 14-char values.
-- NOTE: direct-SQL script — bypasses the app audit log by design (metadata
-- completeness fix; no accounting values change). Run log: applied to
-- dazbeez-receipts prod on 2026-07-08.

UPDATE receipt_records
SET invoice_registration_number = json_extract(extraction_json, '$.invoiceRegistrationNumber'),
    invoice_registration_status = 'format_valid',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE deleted_at IS NULL
  AND invoice_registration_number IS NULL
  AND json_extract(extraction_json, '$.invoiceRegistrationNumber') LIKE 'T%'
  AND length(json_extract(extraction_json, '$.invoiceRegistrationNumber')) = 14;
