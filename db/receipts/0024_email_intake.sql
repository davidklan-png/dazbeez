-- 0024_email_intake.sql
--
-- ADR 0011: inbound email receipt intake at receipts@dazbeez.com. Mail is
-- parsed by a Worker `email()` handler; attachments land here for human
-- triage. Nothing in this table is a tax record until a human explicitly
-- promotes a row (which calls the existing createReceiptRecord()).
--
-- Deliberate differences from receipt_records (per ADR 0011 "Decision"):
--   - No retention_until / legal_hold columns. Unreviewed, unauthenticated
--     mail must NOT inherit the 10-year retention / legal-hold posture that
--     every receipt_records insert correctly assumes. Retention is short
--     (cleanup deletes R2 after 30 days; the row is kept with a nulled
--     attachment_r2_key for audit history). Adding these columns here would
--     be wrong — do not.
--   - status is a 3-state triage lifecycle (pending_triage → promoted |
--     rejected), intentionally separate from the receipt_records status
--     CHECK so the two lifecycles cannot accidentally entangle.
--   - promoted_receipt_id references receipt_records(id) only AFTER a
--     promote; it is NULL until then.
--
-- See docs/adr/0011-email-receipt-intake.md for the full rationale and the
-- "why a separate table" alternative-rejected analysis.
CREATE TABLE IF NOT EXISTS email_receipt_intake (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  from_address TEXT NOT NULL,
  subject TEXT,
  spf_pass INTEGER NOT NULL DEFAULT 0,
  dkim_pass INTEGER NOT NULL DEFAULT 0,
  attachment_r2_key TEXT,
  attachment_sha256 TEXT,
  attachment_content_type TEXT,
  attachment_size_bytes INTEGER,
  attachment_filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending_triage'
    CHECK (status IN ('pending_triage','promoted','rejected')),
  reject_reason TEXT,
  promoted_receipt_id TEXT REFERENCES receipt_records(id),
  raw_headers_json TEXT,
  created_at TEXT NOT NULL
);

-- Triage queue is the hot read path (the /receipts/inbox screen lists
-- pending_triage, newest first). Status-first keeps the working set small
-- even as promoted/rejected history accumulates.
CREATE INDEX IF NOT EXISTS idx_email_intake_status
  ON email_receipt_intake(status, received_at);
