-- Unknown historical arrival stays NULL; never infer arrival from sender Date
-- or processing time. Old producers remain compatible with this nullable field.
ALTER TABLE email_receipt_intake ADD COLUMN arrived_at TEXT;
