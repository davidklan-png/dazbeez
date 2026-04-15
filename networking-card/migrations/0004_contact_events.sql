CREATE TABLE IF NOT EXISTS contact_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token TEXT NOT NULL REFERENCES cards(token),
  source TEXT NOT NULL CHECK(source IN ('google', 'linkedin', 'manual')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO contact_events (contact_id, token, source, name, email, created_at)
SELECT contacts.id,
       contacts.token,
       contact_methods.method,
       contacts.name,
       contacts.email,
       contact_methods.created_at
FROM contact_methods
INNER JOIN contacts ON contacts.id = contact_methods.contact_id
WHERE NOT EXISTS (
  SELECT 1
  FROM contact_events
  WHERE contact_events.contact_id = contact_methods.contact_id
    AND contact_events.source = contact_methods.method
);

CREATE INDEX IF NOT EXISTS idx_contact_events_contact_id ON contact_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_token ON contact_events(token);
CREATE INDEX IF NOT EXISTS idx_contact_events_created_at ON contact_events(created_at);
