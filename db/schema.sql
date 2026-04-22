CREATE TABLE IF NOT EXISTS contact_submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  email        TEXT NOT NULL,
  company      TEXT,
  phone_number TEXT,
  service      TEXT,
  message      TEXT NOT NULL,
  source       TEXT,
  submitted_at TEXT NOT NULL
);
