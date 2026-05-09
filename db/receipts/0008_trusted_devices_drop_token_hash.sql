-- The cookie is now self-contained (HMAC-signed JSON payload); token_hash
-- is no longer stored. Table was just created in 0007 with no data yet.
DROP TABLE IF EXISTS trusted_devices;

CREATE TABLE IF NOT EXISTS trusted_devices (
  id           TEXT PRIMARY KEY,
  actor        TEXT NOT NULL,
  label        TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_actor ON trusted_devices(actor);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_revoked ON trusted_devices(revoked_at);
