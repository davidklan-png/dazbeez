-- Deduplicate existing contacts before enforcing uniqueness.
DELETE FROM contacts
WHERE id NOT IN (
  SELECT MAX(id)
  FROM contacts
  GROUP BY token, email
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_token_email ON contacts(token, email);

CREATE TABLE IF NOT EXISTS notification_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token TEXT NOT NULL REFERENCES cards(token),
  channel TEXT NOT NULL CHECK(channel IN ('discord', 'email')),
  error_message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_failures_contact_id ON notification_failures(contact_id);
CREATE INDEX IF NOT EXISTS idx_notification_failures_created_at ON notification_failures(created_at);
