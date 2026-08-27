-- 0015: record the visitor's network (AS organization) on every tap.
--
-- Why: cf_city is CGNAT-noisy (a 2026-08-27 visitor in Tokyo geolocated to
-- Ishikawa) and cannot separate humans from crawlers. Cloudflare exposes
-- request.cf.asOrganization — free, same object we already read — which
-- distinguishes "NTT Docomo" / fixed-line ISPs from hosting providers
-- (Hetzner, OVH, Azure) that carry the crawler taps.
--
-- Additive only: new nullable column, no rename, no drop, no rebuild.
-- Do NOT apply with `d1 migrations apply` — see docs/nfc-module.md
-- "Migration rules". Hand-apply with:
--   wrangler d1 execute dazbeez-networking --remote --file=migrations/0015_taps_as_organization.sql
--
-- NOTE: deploy ordering — the logTap INSERT in functions writes this column,
-- so apply this file to remote (and local) BEFORE deploying the code.
-- Existing taps keep as_organization = NULL; only new taps record it.

ALTER TABLE taps ADD COLUMN as_organization TEXT;
