-- Add 研究開発費 (Research & Development) to the canonical expense category
-- master list, ordered immediately before 雑費 (miscellaneous).
--
-- Idempotent upsert: re-runs keep labels/flags/order exact. Does NOT backfill
-- or reclassify existing receipts. The legacy 'research' value continues to map
-- to newspapers_books (LEGACY_CATEGORY_MAP in lib/receipts/categories.ts) —
-- historical legacy values must not be silently reinterpreted as R&D; only this
-- canonical code represents the new category.

-- Research & Development (display_order 150) — upsert so labels/flags stay exact.
INSERT INTO expense_categories
  (code, ja_name, en_name, requires_attendees, default_business_trip_eligible, display_order, updated_at)
VALUES
  ('research_development', '研究開発費', 'Research & Development', 0, 0, 150, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
ON CONFLICT(code) DO UPDATE SET
  ja_name = excluded.ja_name,
  en_name = excluded.en_name,
  requires_attendees = excluded.requires_attendees,
  default_business_trip_eligible = excluded.default_business_trip_eligible,
  display_order = excluded.display_order,
  updated_at = excluded.updated_at;

-- Move Miscellaneous to display_order 160 (now after Research & Development).
UPDATE expense_categories
SET display_order = 160, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE code = 'miscellaneous';
