-- 0032_duplicate_purge_log.sql
-- Audit tombstone + write-time guard for the operator-confirmed duplicate-purge
-- workflow (audit 2026-07-21, architect spec D + correction §5). ADDITIVE.
--
-- Stores ONLY minimal metadata: no full receipt row, no image bytes. The
-- retained canonical receipt remains the accounting record. Because D1 and R2
-- are not cross-service transactional, a job row doubles as the pending-cleanup
-- record: pending_keys_json holds the exact R2 key inventory while status is
-- d1_pending/storage_pending, cleared on completion.
--
-- Lifecycle: d1_pending (inserted in the atomic purge batch, before the
-- guarded receipt delete) -> storage_pending (batch committed) -> completed |
-- storage_failed (after R2 cleanup).
CREATE TABLE IF NOT EXISTS duplicate_purge_log (
  id TEXT PRIMARY KEY,
  purged_receipt_id TEXT NOT NULL,
  retained_receipt_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- 'strong' | 'near' — derived server-side per retained/target pair.
  duplicate_strength TEXT NOT NULL CHECK (duplicate_strength IN ('strong','near')),
  -- Hash only: proof of which file was purged, without retaining the file.
  purged_original_sha256 TEXT,
  storage_object_count INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {bucket, key} while cleanup is pending; NULL once completed.
  pending_keys_json TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('d1_pending','storage_pending','completed','storage_failed')),
  error_text TEXT,
  -- Write-time optimistic guards (correction §5): the target's preflight
  -- updated_at and the retained receipt's preflight updated_at. The trigger
  -- below ABORTs the whole purge batch if either changed, or if the target
  -- gained an AMEX claim / export item / disallowed status between preflight
  -- and delete.
  expected_updated_at TEXT NOT NULL,
  retained_expected_updated_at TEXT NOT NULL,
  -- Operator explicitly acknowledged this is the narrow, operator-confirmed
  -- duplicate exception to receipt retention / legal hold (correction §2).
  legal_hold_exception_acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_duplicate_purge_status ON duplicate_purge_log(status);
-- UNIQUE on purged_receipt_id: prevents concurrent/replayed double-purge.
-- Two requests that both preflight the same target: request A inserts a
-- tombstone + deletes the receipt; request B's INSERT for the same
-- purged_receipt_id fails on UNIQUE → the whole batch aborts (no second
-- tombstone, no R2 cleanup, no false second-purge report).
CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_purge_purged ON duplicate_purge_log(purged_receipt_id);
CREATE INDEX IF NOT EXISTS idx_duplicate_purge_retained ON duplicate_purge_log(retained_receipt_id);

-- ─── Write-time guard trigger (correction §5) ───────────────────────────────
-- Fires only for a receipt that has a d1_pending duplicate-purge job — i.e. the
-- duplicate-purge batch's own DELETE. The ordinary upload-compensation
-- hardDeleteReceipt path has no such job, so the WHEN clause is false and that
-- path is completely unaffected (verified by the existing upload tests).
--
-- Each SELECT RAISE(ROLLBACK, ...) fires only when its WHERE matches a bad
-- state at delete time; RAISE(ROLLBACK) rolls back the entire D1 batch so no
-- target's references, tombstone, or receipt row survive a guard failure on any
-- target. This is a true write-time check, not a post-hoc changes() check.
CREATE TRIGGER IF NOT EXISTS duplicate_purge_guard_before_delete
BEFORE DELETE ON receipt_records
WHEN EXISTS (
  SELECT 1 FROM duplicate_purge_log
   WHERE purged_receipt_id = OLD.id AND status = 'd1_pending'
)
BEGIN
  -- Target row changed between preflight and delete (optimistic updated_at).
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: target updated_at changed after preflight')
    FROM duplicate_purge_log
   WHERE purged_receipt_id = OLD.id AND status = 'd1_pending'
     AND expected_updated_at IS NOT OLD.updated_at;
  -- Target status left the purgeable set.
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: target status no longer purgeable')
    FROM duplicate_purge_log
   WHERE purged_receipt_id = OLD.id AND status = 'd1_pending'
     AND OLD.status NOT IN ('captured','needs_review','reviewed');
  -- Target was deleted between preflight and delete.
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: target already deleted')
    FROM duplicate_purge_log
   WHERE purged_receipt_id = OLD.id AND status = 'd1_pending'
     AND OLD.deleted_at IS NOT NULL;
  -- Target gained a matched/confirmed AMEX claim (registered → not purgeable).
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: target gained an AMEX claim')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (
       SELECT 1 FROM amex_statement_lines l
        WHERE l.matched_receipt_id = OLD.id
          AND l.match_status IN ('matched','confirmed')
     );
  -- Target appears in a shipped export item.
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: target gained an export item')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (
       SELECT 1 FROM receipt_export_items i
        WHERE i.item_type = 'receipt' AND i.item_id = OLD.id
     );
  -- Retained receipt must still exist, be non-deleted, and match its preflight
  -- updated_at (so a retained-row change aborts every target's purge).
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: retained receipt missing or changed')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND NOT EXISTS (
       SELECT 1 FROM receipt_records r
        WHERE r.id = j.retained_receipt_id
          AND r.deleted_at IS NULL
          AND r.updated_at = j.retained_expected_updated_at
     );
  -- ── §3 TOCTOU: residual target references after cleanup/transfer ──────
  -- These fire BEFORE the DELETE commits. If any reference to the target
  -- survived the batch's cleanup statements (because it was added/changed
  -- AFTER preflight), the whole batch aborts — no partial purge.
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: residual business-trip links')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (SELECT 1 FROM business_trip_report_receipts WHERE receipt_id = OLD.id);
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: residual email-intake promotion')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (SELECT 1 FROM email_receipt_intake WHERE promoted_receipt_id = OLD.id);
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: residual category-rule membership')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (
       SELECT 1 FROM merchant_category_rules r, json_each(r.source_receipt_ids_json)
        WHERE r.source_receipt_ids_json LIKE '%' || OLD.id || '%'
          AND json_each.value = OLD.id
     );
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: residual receipt_files')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (SELECT 1 FROM receipt_files WHERE object_type='receipt' AND object_id = OLD.id);
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: residual attendees')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (SELECT 1 FROM receipt_attendees WHERE receipt_id = OLD.id);
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: residual compliance checks')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (SELECT 1 FROM receipt_compliance_checks WHERE object_type='receipt' AND object_id = OLD.id);
  SELECT RAISE(ROLLBACK, 'duplicate-purge guard: residual audit log')
    FROM duplicate_purge_log j
   WHERE j.purged_receipt_id = OLD.id AND j.status = 'd1_pending'
     AND EXISTS (SELECT 1 FROM receipt_audit_log WHERE object_type='receipt' AND object_id = OLD.id);
END;
