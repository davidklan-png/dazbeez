CREATE TABLE IF NOT EXISTS contact_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('google', 'linkedin', 'manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contact_id, method)
);

INSERT OR IGNORE INTO contact_methods (contact_id, method)
SELECT id, source
FROM contacts
WHERE source IN ('google', 'linkedin', 'manual');

CREATE INDEX IF NOT EXISTS idx_contact_methods_contact_id ON contact_methods(contact_id);
