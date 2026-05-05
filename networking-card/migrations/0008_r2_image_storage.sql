CREATE TABLE IF NOT EXISTS business_card_image_objects (
  image_id INTEGER PRIMARY KEY REFERENCES business_card_images(id) ON DELETE CASCADE,
  r2_object_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_card_image_objects_key
  ON business_card_image_objects(r2_object_key);
