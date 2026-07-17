-- 0022_attendee_directory.sql
--
-- Attendee directory: the company/title lookup the monthly export
-- bundle joins attendee ids against. Seeded once from the hardcoded TS
-- array (lib/receipts/attendee-directory.ts ATTENDEE_DIRECTORY_SEED), with
-- ids 1-66 preserved verbatim — they are the join key the receipts CSV's
-- AttendeeIds column carries, so renumbering would break sealed exports.
-- Registering a new attendee is now a data operation (POST
-- /api/receipts/attendee-directory), not a code deploy. Resolution against
-- receipt_attendees / amex_line_attendees is by EXACT name match (no FK,
-- no fuzzy matching — attendee identity = directory name).
--
-- created_at/updated_at use a fixed ISO literal so the seed is deterministic
-- (re-running the migration produces identical rows).
CREATE TABLE IF NOT EXISTS attendee_directory (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seed rows (ids 1-66, exact). INSERT OR IGNORE so re-running is a no-op.
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (1, '村上多寿子', '合同会社Dazbeez', '代表社員', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (2, 'クランデイビット', '合同会社Dazbeez', '代表社員', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (3, 'Murray Duke', 'Manulife', 'Program Director', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (4, 'Jose Orfao', 'Manulife', 'CFO', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (5, 'Stefan Goetzinger', 'Manulife', 'Program Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (6, 'Shashidar Shetty', 'Manulife', 'Project Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (7, 'Maki Phillips', 'Manulife', 'Project Management Officer', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (8, 'Casey Medsker', 'Manulife', 'Cognizant Test Lead', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (9, 'Nate Kemppainen', 'Manulife', 'Project Governance Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (10, '山岸リカ', 'Manulife', 'Project Operation Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (11, 'Mizuki Gagnet', 'Manulife', 'ETS Change Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (12, 'Ferdinand Shimizu', 'Manulife', 'ETS Network Engineer', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (13, 'Miako Chiyo', 'Deloitte', 'Program Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (14, 'Steve Dalrymple', 'Manulife', 'Project Finance Lead', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (15, 'Kenji Iyori', 'AIG Technologies KK', 'Infra Project Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (16, '奥野和美', 'AIG Technologies KK', 'Tech Lead', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (17, 'Jason De Luka', 'Smart Partners', 'President', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (18, '高橋　遥', 'Smart Partners', 'Administrator', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (19, 'Stephan Kent', 'FMP Connect KK', 'President', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (20, 'Aaron Ward', 'NN Life', 'Project Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (21, 'Jason Mostella', 'Microsoft Japan KK', 'Lead Developer', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (22, 'Ankit Shrimal', 'Orix Insurance Japan KK', 'Digital Transformation PM', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (23, 'Gary Binda', 'Paypay', 'Business Continuity Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (24, 'Arnash Gupta', 'Asurion Japan KK', 'Rakuten', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (25, 'Vinoth Rajeswaran', 'Cognizant', 'Application Project Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (26, 'Ali Tasbasi', 'Mammoth Istanbul co., ltd.', 'President', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (27, '下倉 淳介', '輝心堂', 'Owner', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (28, '滝沢　秀一', '一般社団法人ごみプロジェクト', '代表', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (29, '柴山佳世', 'Palette814', 'Staff', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (30, '千代　未亜子', 'ACkT Partners', 'Partner 取締役', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (31, '細川　環', 'PanOrient New Corporation', 'Editorial Assistant', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (32, '及川　雅人', 'Deloitte Tohmatsu Consulting', 'Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (33, '中田　圭', '（株）パズルステージ', '代表取締役', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (34, 'David Isenga', 'ACT Laboratoreis', 'Test Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (35, 'Luke Bossenbrook', 'K&H Consultation', 'Construction Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (36, 'Mark Peckham', 'State of Michigan', 'Sr Software Engineer', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (37, 'Mike Post', 'State of Michigan FOC', 'Database Technician', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (38, 'Martha Llewellen', 'Knitty Gritty Treasures, LLC', 'Co-Founder', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (39, 'Grace Mayweather', 'Hopper Casual', 'Sales person', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (40, 'Payton Fredericksen', 'MITTEN Distribution', 'Account Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (41, 'Deanna Helmlinger', 'Your IT Process', 'Owner', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (42, 'Monica Crothers', 'It works!', 'Independent Distributor', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (43, 'Zain Chang', 'GlobalPM', 'Program Director', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (44, 'Donald Dahl', 'Creative 3D', 'Design Director', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (45, 'George Otani', 'Da808Lounge', 'Owner', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (46, 'Mary Reilly', 'Floral Image', 'Owner', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (47, 'Stefano', 'FromFieldandFlower.co.uk', 'Owner', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (48, 'Julius Fielder', 'slowfood.org.uk', 'Ambassador', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (49, 'George Pumfrett', 'Enterprise Holdings', 'Management Assistant', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (50, 'Steven Delaney', 'Enterprise Holdings', 'Branch Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (51, 'John Staniland', 'Staniland Press', 'Travel Writer', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (52, 'Luis Renteria', 'Tinto', 'Artisan Torrefacteur', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (53, 'Alizee Golfier', 'Culture Japon', 'Video Producer', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (54, 'Donald Gates', 'Schroders', 'Investment Finance', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (55, 'Bill Reed', 'Accenture', 'Consultant', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (56, 'Teren Smith', 'Computer Futures', 'Principle Consultant', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (57, 'Glenn Page', 'Hitachi Logistics', 'Sr Consultant', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (58, 'Hiroko Page', 'Hitachi Logistics', 'Sr Consultant', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (59, 'James Sharpe', 'Oshiro Models', 'Model Engineer', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (60, 'Machi Sharpe', 'All Nippon Airways', 'Flight Agent', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (61, 'Eric Soon', 'Manulife Japan', 'Project Manager', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (62, 'Nathan Klan', 'Palmer', 'Site Inspector', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (63, 'Tara Lamacchia', 'Haslett Schools', 'Interpreter', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (64, '森岡蘭多', '森岡株式会社', '代表取締役', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (65, '柴山哲也', 'Palette814', 'Owner', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
INSERT OR IGNORE INTO attendee_directory (id, name, company, title, created_at, updated_at) VALUES (66, '島　義行', '日進ビルサービス株式会社', '代表取締役', '2026-07-17T00:00:00Z', '2026-07-17T00:00:00Z');
