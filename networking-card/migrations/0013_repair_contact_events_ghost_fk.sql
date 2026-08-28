-- ============================================================================
-- 0013_repair_contact_events_ghost_fk.sql
--
--   *** DRAFT — NOT APPLIED. DO NOT RUN AGAINST PRODUCTION WITHOUT: ***
--   1. Rehearsal on a local scratch D1 seeded with the REAL production DDL
--      and comparable row counts (pull DDL from sqlite_master, not this file).
--   2. A D1 Time Travel bookmark taken immediately before execution; record
--      the bookmark id in the change log.
--   3. Delivery via `npx wrangler d1 execute dazbeez-networking --remote
--      --file=...` — NEVER `wrangler d1 migrations apply` (see
--      docs/nfc-module.md "Migration rules").
--   4. A ghost-check before AND after (see RUNBOOK below).
--
-- WHAT THIS FIXES
--   contact_events.batch_card_id currently carries a ghost FK:
--     REFERENCES "batch_cards_old_fk_repair"(id) ON DELETE SET NULL
--   (migration 0009's rename rewrote it; 0009:343 dropped the target).
--   This rebuilds contact_events with the FK REMOVED — batch_card_id becomes
--   a plain INTEGER column, matching the design of contact_events_v2 (0010).
--   Removal, not repointing, is deliberate: nothing in the live code writes
--   a non-NULL batch_card_id, and an FK to batch_cards would re-ghost if
--   batch_cards is ever rebuilt again.
--
-- WHY THE REBUILD IS SAFE HERE (verified live 2026-08-26, re-verify in
-- rehearsal):
--   - Nothing references contact_events. The only cross-reference found in
--     sqlite_master is email_reply_ingest_log.event_id → contact_events_v2(id)
--     (the _v2 table — untouched by this migration). Renaming contact_events
--     therefore rewrites no REFERENCES clauses elsewhere.
--   - No triggers exist on contact_events.
--   - Row count at draft time: 31 (31 rows of capture history — the Time
--     Travel bookmark exists for exactly this).
--
-- RUNBOOK (ghost-check queries):
--   BEFORE: confirm the ghost you are fixing —
--     SELECT name, sql FROM sqlite_master
--     WHERE sql LIKE '%old_fk_repair%';   -- expect: contact_events, business_card_images
--   AFTER: expect ZERO rows from the same query for contact_events
--   (business_card_images remains until 0014), and —
--     SELECT COUNT(*) FROM contact_events;              -- must equal pre-migration count
--     SELECT id, contact_id, source, created_at FROM contact_events ORDER BY id DESC LIMIT 5;
--   plus one live capture (Google + manual) via the card.
--
-- NOTE: the shim table batch_cards_old_fk_repair must SURVIVE this migration;
--   business_card_images still depends on it until 0014 lands. Dropping the
--   shim is a separate, final step gated on BOTH 0013 and 0014 being applied
--   and verified.
-- ============================================================================

PRAGMA foreign_keys = OFF;

ALTER TABLE contact_events RENAME TO contact_events_repair_tmp;

CREATE TABLE contact_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token TEXT REFERENCES cards(token),
  batch_id INTEGER REFERENCES contact_batches(id) ON DELETE SET NULL,
  batch_card_id INTEGER,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK(source IN (
    'google',
    'linkedin',
    'manual',
    'google_oauth',
    'linkedin_oauth',
    'nfc_card',
    'qr_card',
    'manual_form',
    'paper_card_batch_upload',
    'admin_manual_entry'
  )),
  event_type TEXT NOT NULL DEFAULT 'contact_captured',
  name TEXT NOT NULL,
  email TEXT,
  summary TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Explicit column lists on both sides. No SELECT * — column order surviving
-- a rebuild is exactly the implicit dependency that caused the incident.
INSERT INTO contact_events (
  id,
  contact_id,
  token,
  batch_id,
  batch_card_id,
  company_id,
  source,
  event_type,
  name,
  email,
  summary,
  payload_json,
  created_at
)
SELECT
  id,
  contact_id,
  token,
  batch_id,
  batch_card_id,
  company_id,
  source,
  event_type,
  name,
  email,
  summary,
  payload_json,
  created_at
FROM contact_events_repair_tmp;

CREATE INDEX IF NOT EXISTS idx_contact_events_contact_id ON contact_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_token ON contact_events(token);
CREATE INDEX IF NOT EXISTS idx_contact_events_batch_id ON contact_events(batch_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_created_at ON contact_events(created_at);

DROP TABLE contact_events_repair_tmp;

PRAGMA foreign_keys = ON;
