-- Add 雑費 (miscellaneous) to the canonical expense category master list.
-- Code is 'miscellaneous', NOT 'misc': the 0006 migration's legacy mapping
-- deliberately sends old free-text 'misc' values to null (require review);
-- reusing that string as a canonical code would silently legitimize them.
INSERT OR IGNORE INTO expense_categories
  (code, ja_name, en_name, requires_attendees, default_business_trip_eligible, display_order)
VALUES
  ('miscellaneous', '雑費', 'Miscellaneous expenses', 0, 0, 150);
