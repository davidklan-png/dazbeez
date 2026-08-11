-- 0040_delivery_signature.sql
--
-- Email-only delivery signature (delivery-composer decision 3). Appended to the
-- delivery email body AFTER the sealed pack notice's closing line; it does NOT
-- enter buildPackNotice (the notice inside the sealed ZIP is unchanged) — it is
-- a transport-layer adornment on the delivery email only, configured under
-- Settings → Compliance.
--
-- NOTE: receipt_settings is a KEY/VALUE table (key TEXT PRIMARY KEY, value TEXT
-- NOT NULL — see 0014_compliance.sql), NOT a wide table. So a new setting is
-- added as a seeded ROW, not via ALTER TABLE ADD COLUMN — exactly how
-- notification_recipient / notification_cc_recipient were introduced (as app-
-- code keys, read with a COMPLIANCE_DEFAULTS fallback). This seed row mirrors
-- 0014's seed block purely for migration-trail discoverability; the app reads
-- the key with an empty-string default whether or not the row exists
-- (INSERT OR IGNORE makes re-runs safe and the row effectively a no-op).
-- Additive only; no backfill.
INSERT OR IGNORE INTO receipt_settings (key, value, updated_at, updated_by)
VALUES ('delivery_signature', '', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system');
