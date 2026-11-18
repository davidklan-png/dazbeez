-- Browser keys belong to the authenticated actor; native keys remain device-scoped.
ALTER TABLE receipt_records ADD COLUMN capture_request_fingerprint TEXT;

CREATE UNIQUE INDEX idx_receipt_browser_idempotency
  ON receipt_records(captured_by, client_capture_id)
  WHERE device_id IS NULL AND client_capture_id IS NOT NULL;

-- Operator edits must never redefine the request that originally claimed a key.
CREATE TRIGGER receipt_capture_fingerprint_immutable
BEFORE UPDATE OF capture_request_fingerprint ON receipt_records
WHEN OLD.capture_request_fingerprint IS NOT NULL
 AND NEW.capture_request_fingerprint IS NOT OLD.capture_request_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'capture request fingerprint is immutable');
END;
