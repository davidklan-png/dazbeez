CREATE TABLE IF NOT EXISTS email_reply_ingest_log (
  message_id_header TEXT PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  event_id INTEGER REFERENCES contact_events_v2(id) ON DELETE SET NULL,
  sender_email TEXT,
  subject TEXT,
  status TEXT NOT NULL CHECK(status IN ('captured','skipped_no_match','skipped_self','error')),
  error_message TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_reply_ingest_log_contact_id
  ON email_reply_ingest_log(contact_id);

CREATE INDEX IF NOT EXISTS idx_email_reply_ingest_log_captured_at
  ON email_reply_ingest_log(captured_at);

CREATE INDEX IF NOT EXISTS idx_email_reply_ingest_log_status
  ON email_reply_ingest_log(status);
