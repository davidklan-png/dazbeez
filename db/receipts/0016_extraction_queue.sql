-- 0016_extraction_queue.sql
--
-- ADR 0001: store-and-forward extraction. Capture enqueues a job to a durable
-- Cloudflare Queue; the Mac MLX consumer drains it. `status='captured'` remains
-- the user-facing "pending processing" marker; these columns make the queue
-- mirror observable (which captures are queued, in flight, done, or failed)
-- without coupling user-facing status to internal queue mechanics.
--
--   extraction_state lifecycle:
--     captured   -> row created, not yet enqueued (or queue unavailable)
--     queued     -> job is on the Cloudflare Queue, awaiting the Mac
--     processing -> consumer leased the job and is running the model
--     processed  -> model applied + regex guardrail run; status advanced
--     failed     -> consumer exhausted retries; needs manual attention

ALTER TABLE receipt_records
  ADD COLUMN extraction_state TEXT NOT NULL DEFAULT 'captured'
  CHECK (extraction_state IN ('captured', 'queued', 'processing', 'processed', 'failed'));

ALTER TABLE receipt_records ADD COLUMN extraction_enqueued_at TEXT;
ALTER TABLE receipt_records ADD COLUMN extraction_processed_at TEXT;
ALTER TABLE receipt_records ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receipt_records ADD COLUMN extraction_processor TEXT;

-- Existing rows pre-date the queue. They already have extraction_json (or were
-- captured under the old synchronous flow), so treat them as processed so they
-- do not block month-close as phantom "pending processing".
UPDATE receipt_records
SET extraction_state = 'processed',
    extraction_processed_at = COALESCE(created_at, captured_at)
WHERE extraction_state = 'captured';

-- Finalize gate and the dashboard "pending processing" tile query captures that
-- are not yet processed.
CREATE INDEX IF NOT EXISTS idx_receipts_extraction_state
  ON receipt_records(extraction_state)
  WHERE extraction_state IN ('captured', 'queued', 'processing');
