-- Receipt Module: mobile device pairing + idempotency
-- Run: npx wrangler d1 migrations apply RECEIPTS_DB [--local]

ALTER TABLE trusted_devices ADD COLUMN platform TEXT;          -- 'web' | 'ios'
ALTER TABLE trusted_devices ADD COLUMN app_version TEXT;
ALTER TABLE trusted_devices ADD COLUMN scopes_json TEXT;

CREATE TABLE IF NOT EXISTS mobile_pairing_codes (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_device_id TEXT,
  consumed_at TEXT,
  -- Bearer token is delivered exactly once to the polling iPhone, then
  -- cleared. The browser-side complete-pairing call writes it; the
  -- iPhone-side /check read clears it.
  bearer_token TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobile_pairing_codes_expires
  ON mobile_pairing_codes(expires_at);

ALTER TABLE receipt_records ADD COLUMN device_id TEXT;
ALTER TABLE receipt_records ADD COLUMN client_capture_id TEXT;
ALTER TABLE receipt_records ADD COLUMN captured_at_client TEXT;
ALTER TABLE receipt_records ADD COLUMN upload_origin TEXT;     -- 'web' | 'mobile'

CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_mobile_idempotency
  ON receipt_records(device_id, client_capture_id)
  WHERE device_id IS NOT NULL AND client_capture_id IS NOT NULL;
