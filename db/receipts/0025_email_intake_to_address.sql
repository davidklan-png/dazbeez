-- 0025_email_intake_to_address.sql
--
-- Adds to_address to email_receipt_intake so a human triaging /receipts/inbox
-- can see which alias (receipts@ or receipt@dazbeez.com) captured a given email.
-- Nullable — older rows predate this column; no backfill. Intake-side metadata
-- only; does NOT flow into receipt_records on promote (ADR 0011 follow-up,
-- 2026-07-19 scope-change note).
ALTER TABLE email_receipt_intake ADD COLUMN to_address TEXT;
