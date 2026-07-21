-- 0032_duplicate_purge_log.sql
-- Audit tombstone for the operator-confirmed duplicate-purge workflow
-- (audit 2026-07-21, architect spec D). ADDITIVE — no changes to existing
-- tables. Stores ONLY minimal metadata: no full receipt row, no image bytes.
-- The retained canonical receipt remains the accounting record.
--
-- Because D1 and R2 are not cross-service transactional, this row doubles as the
-- pending-cleanup job: while storage cleanup runs, `pending_keys_json` holds the
-- exact R2 key inventory and status stays 'storage_pending'. On full success the
-- inventory is cleared and status='completed'; on any R2 failure status=
-- 'storage_failed' and the inventory is RETAINED so a retry can finish the job
-- without recreating the purged receipt.
CREATE TABLE IF NOT EXISTS duplicate_purge_log (
  id TEXT PRIMARY KEY,
  purged_receipt_id TEXT NOT NULL,
  retained_receipt_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- 'strong' | 'near' (the duplicate-candidate strength that justified the purge)
  duplicate_strength TEXT NOT NULL CHECK (duplicate_strength IN ('strong','near')),
  -- Hash only: proof of which file was purged, without retaining the file itself.
  purged_original_sha256 TEXT,
  -- Number of R2 objects inventoried for this purge (deduped).
  storage_object_count INTEGER NOT NULL DEFAULT 0,
  -- Exact pending R2 cleanup inventory while the job runs; cleared on completion.
  -- JSON array of {bucket, key}.
  pending_keys_json TEXT,
  status TEXT NOT NULL DEFAULT 'storage_pending'
    CHECK (status IN ('storage_pending','completed','storage_failed')),
  error_text TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_duplicate_purge_status ON duplicate_purge_log(status);
CREATE INDEX IF NOT EXISTS idx_duplicate_purge_purged ON duplicate_purge_log(purged_receipt_id);
CREATE INDEX IF NOT EXISTS idx_duplicate_purge_retained ON duplicate_purge_log(retained_receipt_id);
