-- Canonical expense category master list
CREATE TABLE IF NOT EXISTS expense_categories (
  code              TEXT PRIMARY KEY,
  ja_name           TEXT NOT NULL,
  en_name           TEXT NOT NULL,
  requires_attendees INTEGER NOT NULL DEFAULT 0,
  default_business_trip_eligible INTEGER NOT NULL DEFAULT 0,
  display_order     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT OR IGNORE INTO expense_categories (code, ja_name, en_name, requires_attendees, default_business_trip_eligible, display_order) VALUES
  ('employee_welfare',      '福利厚生費', 'Employee welfare expenses',          0, 0,  10),
  ('advertising_promotion', '広告宣伝費', 'Advertising and promotion expenses',  0, 0,  20),
  ('entertainment',         '交際費',     'Entertainment expenses',              1, 0,  30),
  ('meeting',               '会議費',     'Meeting expenses',                    1, 0,  40),
  ('travel_transportation', '旅費交通費', 'Travel and transportation expenses',  0, 1,  50),
  ('communications',        '通信費',     'Communications expenses',             0, 0,  60),
  ('sales_commissions',     '販売手数料', 'Sales commissions',                   0, 0,  70),
  ('supplies',              '消耗品費',   'Supplies and consumables',            0, 0,  80),
  ('utilities',             '水道光熱費', 'Utilities',                           0, 0,  90),
  ('newspapers_books',      '新聞図書費', 'Newspapers and books',                0, 0, 100),
  ('membership_dues',       '諸会費',     'Membership dues',                     0, 0, 110),
  ('payment_fees',          '支払手数料', 'Payment and service fees',            0, 0, 120),
  ('rent_lease',            '賃借料',     'Rent and lease expenses',             0, 0, 130),
  ('insurance',             '保険料',     'Insurance premiums',                  0, 0, 140);

-- Canonical category code column on receipt_records (nullable — migrating from expense_type string)
ALTER TABLE receipt_records ADD COLUMN expense_category_code TEXT REFERENCES expense_categories(code);

-- Canonical category code column on amex_statement_lines (nullable — migrating from expense_category string)
ALTER TABLE amex_statement_lines ADD COLUMN expense_category_code TEXT REFERENCES expense_categories(code);
