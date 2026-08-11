-- 0041_delivery_reply_to.sql
--
-- Delivery Reply-To (delivery-composer §B). The Reply-To header on the monthly
-- pack delivery email — where an accountant's reply lands. Distinct from the
-- From address so a reply is not parsed as a receipt submission by the public
-- intake address (ADR 0011). Empty = omitted from the Resend payload entirely.
--
-- receipt_settings is a key/value table (key TEXT PRIMARY KEY, value TEXT NOT
-- NULL — see 0014_compliance.sql); a new setting is a seeded ROW, not an ALTER
-- TABLE — the same pattern notification_recipient / notification_cc_recipient /
-- delivery_signature (0040) used. Additive only; no backfill.
INSERT OR IGNORE INTO receipt_settings (key, value, updated_at, updated_by)
VALUES ('delivery_reply_to', '', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'system');
