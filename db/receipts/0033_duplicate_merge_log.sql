-- Atomic duplicate-merge operation record and write-time guards.
-- The merge log is inserted as the first statement of one D1 batch. Any stale
-- receipt, changed attendee set, newly protected source, or re-sealed month
-- aborts the whole batch before the retained receipt is modified.
CREATE TABLE IF NOT EXISTS duplicate_merge_log (
  id TEXT PRIMARY KEY,
  retained_receipt_id TEXT NOT NULL,
  retained_expected_updated_at TEXT NOT NULL,
  retained_attendees_json TEXT NOT NULL,
  source_snapshots_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  resolution_plan_json TEXT NOT NULL,
  old_value_json TEXT NOT NULL,
  new_value_json TEXT NOT NULL,
  candidate_strengths_json TEXT NOT NULL,
  correction_export_id TEXT,
  correction_month TEXT,
  correction_revision INTEGER,
  correction_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_duplicate_merge_retained
  ON duplicate_merge_log(retained_receipt_id, created_at);

CREATE TRIGGER IF NOT EXISTS duplicate_merge_guard_before_insert
BEFORE INSERT ON duplicate_merge_log
BEGIN
  SELECT RAISE(ROLLBACK, 'duplicate-merge guard: malformed snapshots')
   WHERE json_valid(NEW.source_snapshots_json) = 0
      OR json_type(NEW.source_snapshots_json) != 'array'
      OR json_array_length(NEW.source_snapshots_json) = 0
      OR json_valid(NEW.retained_attendees_json) = 0
      OR json_type(NEW.retained_attendees_json) != 'array';

  SELECT RAISE(ROLLBACK, 'duplicate-merge guard: retained missing or changed')
   WHERE NOT EXISTS (
     SELECT 1 FROM receipt_records r
      WHERE r.id = NEW.retained_receipt_id
        AND r.deleted_at IS NULL
        AND r.payment_path = 'AMEX'
        AND r.status != 'archived'
        AND r.updated_at = NEW.retained_expected_updated_at
   );

  SELECT RAISE(ROLLBACK, 'duplicate-merge guard: retained attendee set changed')
   WHERE (SELECT COUNT(*) FROM receipt_attendees a
           WHERE a.receipt_id = NEW.retained_receipt_id)
         != json_array_length(NEW.retained_attendees_json)
      OR EXISTS (
        SELECT 1 FROM receipt_attendees a
         WHERE a.receipt_id = NEW.retained_receipt_id
           AND NOT EXISTS (
             SELECT 1 FROM json_each(NEW.retained_attendees_json) j
              WHERE json_extract(j.value, '$.id') = a.id
                AND json_extract(j.value, '$.attendeeName') = a.attendee_name
                AND json_extract(j.value, '$.company') IS a.company
                AND json_extract(j.value, '$.relationship') IS a.relationship
                AND json_extract(j.value, '$.isDazbeezEmployee') = a.is_dazbeez_employee
                AND json_extract(j.value, '$.notes') IS a.notes
                AND json_extract(j.value, '$.createdAt') = a.created_at
           )
      );

  SELECT RAISE(ROLLBACK, 'duplicate-merge guard: source missing, changed, or protected')
   WHERE EXISTS (
     SELECT 1 FROM json_each(NEW.source_snapshots_json) s
      WHERE NOT EXISTS (
        SELECT 1 FROM receipt_records r
         WHERE r.id = json_extract(s.value, '$.id')
           AND r.id != NEW.retained_receipt_id
           AND r.deleted_at IS NULL
           AND r.payment_path = 'AMEX'
           AND r.status IN ('captured','needs_review','reviewed')
           AND NOT (
             r.extraction_state IN ('captured','queued','processing')
             OR (r.extraction_state IS NULL AND r.status = 'captured')
           )
           AND r.updated_at = json_extract(s.value, '$.updatedAt')
           AND NOT EXISTS (
             SELECT 1 FROM amex_statement_lines l
              WHERE l.matched_receipt_id = r.id
                AND l.match_status IN ('matched','confirmed')
           )
           AND NOT EXISTS (
             SELECT 1 FROM receipt_export_items i
              WHERE i.item_type = 'receipt' AND i.item_id = r.id
           )
      )
   );

  SELECT RAISE(ROLLBACK, 'duplicate-merge guard: source attendee set changed')
   WHERE EXISTS (
     SELECT 1 FROM json_each(NEW.source_snapshots_json) s
      WHERE (SELECT COUNT(*) FROM receipt_attendees a
              WHERE a.receipt_id = json_extract(s.value, '$.id'))
            != json_array_length(json_extract(s.value, '$.attendees'))
         OR EXISTS (
           SELECT 1 FROM receipt_attendees a
            WHERE a.receipt_id = json_extract(s.value, '$.id')
              AND NOT EXISTS (
                SELECT 1 FROM json_each(json_extract(s.value, '$.attendees')) j
                 WHERE json_extract(j.value, '$.id') = a.id
                   AND json_extract(j.value, '$.attendeeName') = a.attendee_name
                   AND json_extract(j.value, '$.company') IS a.company
                   AND json_extract(j.value, '$.relationship') IS a.relationship
                   AND json_extract(j.value, '$.isDazbeezEmployee') = a.is_dazbeez_employee
                   AND json_extract(j.value, '$.notes') IS a.notes
                   AND json_extract(j.value, '$.createdAt') = a.created_at
              )
         )
   );

  -- ADR 0012: a finalized export/reconciliation locks receipt edits unless a
  -- draft export revision for that same month is open.
  SELECT RAISE(ROLLBACK, 'duplicate-merge guard: retained month is locked')
   WHERE EXISTS (
     SELECT 1 FROM (
       SELECT r.exported_month AS month
         FROM receipt_records r
        WHERE r.id = NEW.retained_receipt_id AND r.exported_month IS NOT NULL
       UNION
       SELECT e.export_month
         FROM receipt_export_items i
         JOIN receipt_exports e ON e.id = i.export_id
        WHERE i.item_type = 'receipt' AND i.item_id = NEW.retained_receipt_id
       UNION
       SELECT ar.statement_month
         FROM amex_statement_lines l
         JOIN amex_reconciliations ar
           ON ar.statement_month = l.statement_month AND ar.status = 'finalized'
        WHERE l.matched_receipt_id = NEW.retained_receipt_id
     ) months
     WHERE EXISTS (
       SELECT 1 FROM receipt_exports f
        WHERE f.export_month = months.month AND f.status = 'finalized'
     )
       AND NOT EXISTS (
         SELECT 1 FROM receipt_exports d
          WHERE d.export_month = months.month AND d.status = 'draft'
       )
   );
END;
