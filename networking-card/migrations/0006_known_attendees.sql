-- Known attendees for personalized post-tap experience.
-- Rows are seeded per-event (see seed-uh-alumni-2026-04-22.sql).
-- email_lower / linkedin_url may be NULL at seed time; they get backfilled
-- later if David recognizes a tapper from the Discord ping.

CREATE TABLE IF NOT EXISTS known_attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_lower TEXT UNIQUE,
  linkedin_url TEXT,
  display_name TEXT NOT NULL,
  event_slug TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('top', 'second', 'third', 'early', 'unknown')),
  role_company TEXT,
  opener TEXT NOT NULL,
  david_notes TEXT,
  cta_type TEXT NOT NULL CHECK(cta_type IN ('mailto_schedule', 'mailto_resource', 'linkedin_only')),
  topic_hint TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_known_attendees_email ON known_attendees(email_lower);
CREATE INDEX IF NOT EXISTS idx_known_attendees_linkedin ON known_attendees(linkedin_url);
CREATE INDEX IF NOT EXISTS idx_known_attendees_event ON known_attendees(event_slug);
