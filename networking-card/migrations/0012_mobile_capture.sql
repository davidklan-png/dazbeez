-- CRM Module: mobile business-card capture columns + idempotency
-- Run: npx wrangler d1 migrations apply CRM_DB [--local]

ALTER TABLE business_card_images_v2 ADD COLUMN device_id TEXT;
ALTER TABLE business_card_images_v2 ADD COLUMN client_capture_id TEXT;
ALTER TABLE business_card_images_v2 ADD COLUMN captured_at_client TEXT;
ALTER TABLE business_card_images_v2 ADD COLUMN upload_origin TEXT;     -- 'web' | 'mobile'
ALTER TABLE business_card_images_v2 ADD COLUMN source_app_version TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_card_mobile_idempotency
  ON business_card_images_v2(device_id, client_capture_id)
  WHERE device_id IS NOT NULL AND client_capture_id IS NOT NULL;
