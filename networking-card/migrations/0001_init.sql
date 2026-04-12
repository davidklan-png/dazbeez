-- Networking card system schema

CREATE TABLE IF NOT EXISTS cards (
  token TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL REFERENCES cards(token),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('google', 'linkedin', 'manual')),
  linkedin_url TEXT,
  company TEXT,
  cf_country TEXT,
  cf_city TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS taps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL REFERENCES cards(token),
  cf_country TEXT,
  cf_city TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_token ON contacts(token);
CREATE INDEX IF NOT EXISTS idx_taps_token ON taps(token);
CREATE INDEX IF NOT EXISTS idx_taps_created_at ON taps(created_at);
