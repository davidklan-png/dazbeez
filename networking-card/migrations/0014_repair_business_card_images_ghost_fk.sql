-- ============================================================================
-- 0014_repair_business_card_images_ghost_fk.sql
--
--   *** DRAFT — NOT APPLIED. DO NOT RUN AGAINST PRODUCTION WITHOUT: ***
--   1. Rehearsal on a local scratch D1 seeded with the REAL production DDL
--      and comparable row counts (pull DDL from sqlite_master, not this file).
--   2. A D1 Time Travel bookmark taken immediately before execution; record
--      the bookmark id in the change log.
--   3. Delivery via `npx wrangler d1 execute dazbeez-networking --remote
--      --file=...` — NEVER `wrangler d1 migrations apply` (see
--      docs/nfc-module.md "Migration rules").
--   4. The ghost-check RUNBOOK below, before AND after.
--
-- WHAT THIS FIXES
--   business_card_images.batch_card_id currently carries a ghost FK:
--     REFERENCES "batch_cards_old_fk_repair"(id) ON DELETE CASCADE
--   This rebuilds business_card_images with the FK REMOVED (plain INTEGER),
--   matching the design of business_card_images_v2 (0010).
--
-- !!! THE TRAP THIS MIGRATION MUST NOT SPRING !!!
--   batch_cards carries INBOUND FKs to business_card_images:
--     cropped_image_id  REFERENCES business_card_images(id) ON DELETE SET NULL
--     enhanced_image_id REFERENCES business_card_images(id) ON DELETE SET NULL
--   A NAIVE `ALTER TABLE business_card_images RENAME TO …tmp` REWRITES THOSE
--   TWO CLAUSES TO THE TMP NAME. Creating a new business_card_images and
--   dropping the tmp then leaves batch_cards with two NEW ghost FKs — the
--   same incident again, one table over. A rename-rebuild here that does not
--   account for this is not a repair, it is a relapse.
--
--   PRIMARY APPROACH (this draft): set `PRAGMA legacy_alter_table = ON`
--   before the RENAME. Under legacy_alter_table, RENAME does NOT rewrite
--   REFERENCES clauses elsewhere — so batch_cards' inbound FKs keep pointing
--   at the name `business_card_images`, which the new table re-occupies.
--   ⚠ D1's support for `PRAGMA legacy_alter_table` is UNVERIFIED — the
--   rehearsal MUST prove it (the AFTER ghost-check below catches failure:
--   a relapse shows up as batch_cards' DDL containing the tmp name).
--   If D1 rejects or ignores the pragma: STOP, do not improvise. Escalate
--   to the architect. The fallback (rebuilding batch_cards AND its own
--   referrers enrichment_runs / synergy_analyses / email_drafts in one
--   coordinated pass — i.e. redoing 0009 correctly) is a separate design
--   decision, not something to hand-roll mid-maintenance-window.
--
-- WHY THE REBUILD IS OTHERWISE SAFE (verified live 2026-08-26, re-verify in
-- rehearsal):
--   - No triggers exist on business_card_images.
--   - business_card_images_v2 / business_card_image_objects_v2 (0010) are
--     separate tables and are not affected by this rename.
--   - No view or other table references business_card_images other than
--     batch_cards' two inbound FKs named above.
--
-- RUNBOOK (ghost-check queries):
--   BEFORE:
--     SELECT name, sql FROM sqlite_master WHERE sql LIKE '%old_fk_repair%';
--       -- expect: business_card_images only (0013 has already fixed contact_events)
--     SELECT sql FROM sqlite_master WHERE name='batch_cards';
--       -- record: cropped_image_id / enhanced_image_id reference
--       -- business_card_images(id) — this DDL must be IDENTICAL after.
--   AFTER: expect ZERO rows for '%old_fk_repair%', batch_cards DDL unchanged,
--     row count preserved, and the unique storage_key index present:
--     SELECT COUNT(*) FROM business_card_images;
--     SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='business_card_images';
--
-- NOTE: this migration is the SECOND half of the shim's retirement. Only
--   after BOTH 0013 and 0014 are applied and verified may the shim table
--   batch_cards_old_fk_repair be dropped (separate explicit step, on the
--   record, with a Time Travel bookmark).
-- ============================================================================

PRAGMA legacy_alter_table = ON;
PRAGMA foreign_keys = OFF;

ALTER TABLE business_card_images RENAME TO business_card_images_repair_tmp;

-- STOP-AND-CHECK (rehearsal only, then remove for the live run or keep as a
-- no-op comment): verify batch_cards' DDL still says
-- REFERENCES business_card_images(id) — NOT the tmp name. If it says the tmp
-- name, legacy_alter_table did NOT take effect: STOP, restore from bookmark,
-- escalate. Do not proceed to the DROP below.
--   SELECT sql FROM sqlite_master WHERE name='batch_cards';

CREATE TABLE business_card_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES contact_batches(id) ON DELETE CASCADE,
  batch_card_id INTEGER,
  image_role TEXT NOT NULL CHECK(image_role IN ('batch_original', 'cropped_card', 'enhanced_card')),
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL,
  sha256 TEXT,
  blob_data BLOB NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Explicit column lists on both sides. No SELECT * — column order surviving
-- a rebuild is exactly the implicit dependency that caused the incident.
INSERT INTO business_card_images (
  id,
  batch_id,
  batch_card_id,
  image_role,
  storage_key,
  mime_type,
  width,
  height,
  byte_size,
  sha256,
  blob_data,
  metadata_json,
  created_at
)
SELECT
  id,
  batch_id,
  batch_card_id,
  image_role,
  storage_key,
  mime_type,
  width,
  height,
  byte_size,
  sha256,
  blob_data,
  metadata_json,
  created_at
FROM business_card_images_repair_tmp;

CREATE INDEX IF NOT EXISTS idx_business_card_images_batch_id ON business_card_images(batch_id);
CREATE INDEX IF NOT EXISTS idx_business_card_images_batch_card_id ON business_card_images(batch_card_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_card_images_storage_key ON business_card_images(storage_key);

DROP TABLE business_card_images_repair_tmp;

PRAGMA foreign_keys = ON;
PRAGMA legacy_alter_table = OFF;
