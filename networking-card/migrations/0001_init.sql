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

CREATE TABLE IF NOT EXISTS notification_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token TEXT NOT NULL REFERENCES cards(token),
  channel TEXT NOT NULL CHECK(channel IN ('discord', 'email')),
  error_message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS contact_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('google', 'linkedin', 'manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contact_id, method)
);

CREATE TABLE IF NOT EXISTS contact_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token TEXT NOT NULL REFERENCES cards(token),
  source TEXT NOT NULL CHECK(source IN ('google', 'linkedin', 'manual')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vcard_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  file_name TEXT NOT NULL,
  family_name TEXT NOT NULL,
  given_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  organization TEXT NOT NULL,
  title TEXT NOT NULL,
  email TEXT NOT NULL,
  website TEXT NOT NULL,
  linkedin TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO vcard_profile (
  id,
  file_name,
  family_name,
  given_name,
  full_name,
  organization,
  title,
  email,
  website,
  linkedin
) VALUES (
  1,
  'david-klan.vcf',
  'Klan',
  'David',
  'David Klan',
  'Dazbeez',
  'AI, Automation & Data Consultant',
  'david@dazbeez.com',
  'https://dazbeez.com',
  'https://www.linkedin.com/in/david-klan'
);

CREATE INDEX IF NOT EXISTS idx_contacts_token ON contacts(token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_token_email ON contacts(token, email);
CREATE INDEX IF NOT EXISTS idx_taps_token ON taps(token);
CREATE INDEX IF NOT EXISTS idx_taps_created_at ON taps(created_at);
CREATE INDEX IF NOT EXISTS idx_contact_methods_contact_id ON contact_methods(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_contact_id ON contact_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_token ON contact_events(token);
CREATE INDEX IF NOT EXISTS idx_contact_events_created_at ON contact_events(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_failures_contact_id ON notification_failures(contact_id);
CREATE INDEX IF NOT EXISTS idx_notification_failures_created_at ON notification_failures(created_at);
