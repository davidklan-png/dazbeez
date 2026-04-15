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
