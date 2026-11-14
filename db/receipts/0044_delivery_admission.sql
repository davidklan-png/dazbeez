-- Operational ownership only; sealed artifacts and historical rows stay intact.
ALTER TABLE receipt_exports ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receipt_exports ADD COLUMN current_delivery_attempt_id TEXT;
ALTER TABLE export_deliveries ADD COLUMN payload_json TEXT;
ALTER TABLE export_deliveries ADD COLUMN admission_generation INTEGER;

-- Legacy timestamps can tie. rowid is only a deterministic insertion tie-break,
-- not evidence of chronological UUID order. Unknown envelopes remain unresumable.
UPDATE receipt_exports SET current_delivery_attempt_id = (
  SELECT attempt_id FROM export_deliveries d WHERE d.export_id = receipt_exports.id
  GROUP BY attempt_id
  ORDER BY MIN(created_at) DESC, MIN(rowid) DESC LIMIT 1
);
CREATE INDEX idx_delivery_logical_attempt ON export_deliveries(export_id, attempt_id);
-- Repair only operational summaries from the chosen legacy owner. A successful
-- retry settles its logical attempt even if another HTTP row remained pending.
UPDATE receipt_exports SET delivery_state = CASE
  WHEN current_delivery_attempt_id IS NULL THEN NULL
  WHEN EXISTS (SELECT 1 FROM export_deliveries d WHERE d.export_id = receipt_exports.id
    AND d.attempt_id = current_delivery_attempt_id AND d.state = 'sent') THEN 'delivered'
  WHEN EXISTS (SELECT 1 FROM export_deliveries d WHERE d.export_id = receipt_exports.id
    AND d.attempt_id = current_delivery_attempt_id AND d.state = 'pending') THEN 'pending'
  ELSE 'sealed_undelivered' END;
