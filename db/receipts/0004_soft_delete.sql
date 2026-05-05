-- Soft delete support for receipt_records.
-- Deleted receipts use deleted_at IS NOT NULL as the flag — no status change,
-- since the existing status CHECK constraint cannot be altered in SQLite.
ALTER TABLE receipt_records ADD COLUMN deleted_at TEXT;
ALTER TABLE receipt_records ADD COLUMN deleted_by TEXT;
ALTER TABLE receipt_records ADD COLUMN delete_reason TEXT;
