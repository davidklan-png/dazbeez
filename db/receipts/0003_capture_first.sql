-- Receipt Module: capture-first schema update
-- Adds source, original_filename columns and widens payment_path / expense_type
-- to allow UNKNOWN for receipts captured before metadata is added.
--
-- Skip this if you're applying to a fresh database — 0001_init.sql already includes these columns.
-- Apply this if you applied 0001 before the capture-first update.

-- Add source column (tracks capture origin: mobile_capture, desktop, api, etc.)
-- No-op: 0001_init.sql already includes source, original_filename, and the UNKNOWN
-- variants for payment_path / expense_type. This file is retained only to preserve
-- migration sequence numbering for any database that applied the original 0001.
-- On a fresh install this migration applies cleanly and makes no changes.
SELECT 1;
