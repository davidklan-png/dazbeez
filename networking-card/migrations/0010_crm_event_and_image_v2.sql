CREATE TABLE IF NOT EXISTS business_card_images_v2 (
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

CREATE INDEX IF NOT EXISTS idx_business_card_images_v2_batch_id ON business_card_images_v2(batch_id);
CREATE INDEX IF NOT EXISTS idx_business_card_images_v2_batch_card_id ON business_card_images_v2(batch_card_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_card_images_v2_storage_key ON business_card_images_v2(storage_key);

INSERT OR IGNORE INTO business_card_images_v2 (
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
FROM business_card_images;

CREATE TABLE IF NOT EXISTS business_card_image_objects_v2 (
  image_id INTEGER PRIMARY KEY REFERENCES business_card_images_v2(id) ON DELETE CASCADE,
  r2_object_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_card_image_objects_v2_key
  ON business_card_image_objects_v2(r2_object_key);

INSERT OR IGNORE INTO business_card_image_objects_v2 (
  image_id,
  r2_object_key,
  created_at
)
SELECT
  image_id,
  r2_object_key,
  created_at
FROM business_card_image_objects;

CREATE TABLE IF NOT EXISTS contact_events_v2 (
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

CREATE INDEX IF NOT EXISTS idx_contact_events_v2_contact_id ON contact_events_v2(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_v2_token ON contact_events_v2(token);
CREATE INDEX IF NOT EXISTS idx_contact_events_v2_batch_id ON contact_events_v2(batch_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_v2_created_at ON contact_events_v2(created_at);

INSERT OR IGNORE INTO contact_events_v2 (
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
FROM contact_events;
