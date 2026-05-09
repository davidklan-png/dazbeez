-- Trusted devices: long-lived cookie auth so a device only needs to pass
-- Cloudflare Access once (at /receipts/enroll). The cookie carries a random
-- token; the DB stores HMAC-SHA256(token) keyed by RECEIPTS_DEVICE_SECRET.

CREATE TABLE IF NOT EXISTS trusted_devices (
  id           TEXT PRIMARY KEY,
  actor        TEXT NOT NULL,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_actor ON trusted_devices(actor);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_revoked ON trusted_devices(revoked_at);
