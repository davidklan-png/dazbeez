-- 2026-07-17-attendee-data-fix.sql
--
-- One-time DATA fix on attendee_directory + receipt_attendees +
-- amex_line_attendees. Provenance for the operator-supplied canonical
-- names/companies/titles that resolve the 10 unresolved attendee names
-- flagged in the attendee-directory audit (business-manager review: every
-- 会議費 / 接待交際費 attendee must show company + title).
-- See WORKER-PROMPT-attendee-data-fix.md.
--
-- Why direct SQL: the sealed-month (2026-06) receipt rows cannot be edited via
-- any API (exported-status guard, app/api/receipts/[id]/route.ts:98), so a
-- single scripted pass beats a mixed UI/SQL cleanup. This is a DATA fix, not a
-- schema migration (no new migration number). No audit_log inserts — this
-- committed script + the worker report are the provenance record.
--
-- Pre-checks (run before executing the changes; abort if any fails):
--   SELECT COUNT(*) FROM attendee_directory;                                  -- expect 66
--   SELECT name FROM attendee_directory WHERE name IN                         -- expect 0 rows
--     ('甲斐澄','Will Laurent','Colin Hilchey','Viju Vincent',
--      'Hassan Musa','Franck Roger','Rhonda Lundin','Steve Kent');
--   SELECT id, name FROM attendee_directory WHERE id = 19;                    -- expect 'Stephan Kent'

-- ─── Directory registrations (7 inserts; id omitted → auto rowid > 66) ───────
-- Fixed timestamp literal on all rows.
INSERT INTO attendee_directory (name, company, title, created_at, updated_at) VALUES ('甲斐澄', 'AIG Technologies KK', 'Project Manager', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
INSERT INTO attendee_directory (name, company, title, created_at, updated_at) VALUES ('Will Laurent', 'BMW', 'Data Scientist', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
INSERT INTO attendee_directory (name, company, title, created_at, updated_at) VALUES ('Colin Hilchey', 'Morgan Stanley', 'Sr Engineer', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
INSERT INTO attendee_directory (name, company, title, created_at, updated_at) VALUES ('Viju Vincent', 'AIG Technologies KK', 'Infra Tech Lead', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
INSERT INTO attendee_directory (name, company, title, created_at, updated_at) VALUES ('Hassan Musa', 'Bank of America', 'System Analyst', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
INSERT INTO attendee_directory (name, company, title, created_at, updated_at) VALUES ('Franck Roger', 'Bank of America', 'System Analyst', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');
INSERT INTO attendee_directory (name, company, title, created_at, updated_at) VALUES ('Rhonda Lundin', 'Lawyers Association', 'Chief Coordinator', '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z');

-- ─── Directory correction: id 19 'Stephan Kent' → 'Steve Kent' (his actual
-- name; he was mislabeled as Stephan). Company/title (FMP Connect KK /
-- President) unchanged. Receipt rows already read 'Steve Kent' (not Stephan),
-- so they resolve once the directory matches.
UPDATE attendee_directory
SET name = 'Steve Kent', updated_at = '2026-07-17T00:00:00.000Z'
WHERE id = 19 AND name = 'Stephan Kent';

-- ─── Receipt-row renames (global by name, TRIM-matched, all months — including
-- the sealed June receipt; that is intended). Rows already reading
-- 'Will Laurent', 'Colin Hilchey', 'Viju Vincent', 'Rhonda Lundin', 'Steve Kent'
-- are correct as recorded and are NOT touched here.
UPDATE receipt_attendees SET attendee_name = '甲斐澄'          WHERE TRIM(attendee_name) = 'Kai kiyoshi';
UPDATE receipt_attendees SET attendee_name = 'クランデイビット' WHERE TRIM(attendee_name) = 'David Klan';
UPDATE receipt_attendees SET attendee_name = '村上多寿子'       WHERE TRIM(attendee_name) = 'Tazuko Murakami';
UPDATE receipt_attendees SET attendee_name = 'Hassan Musa'      WHERE TRIM(attendee_name) = 'Hassan';
UPDATE receipt_attendees SET attendee_name = 'Franck Roger'     WHERE TRIM(attendee_name) = 'franck';
UPDATE receipt_attendees SET attendee_name = 'Steve Kent'       WHERE TRIM(attendee_name) = 'Stephan Kent';

-- ─── Same six against amex_line_attendees for completeness. The audit showed
-- amex_line_attendees clean, so these are expected to change 0 rows — run them
-- anyway and report the counts.
UPDATE amex_line_attendees SET attendee_name = '甲斐澄'          WHERE TRIM(attendee_name) = 'Kai kiyoshi';
UPDATE amex_line_attendees SET attendee_name = 'クランデイビット' WHERE TRIM(attendee_name) = 'David Klan';
UPDATE amex_line_attendees SET attendee_name = '村上多寿子'       WHERE TRIM(attendee_name) = 'Tazuko Murakami';
UPDATE amex_line_attendees SET attendee_name = 'Hassan Musa'      WHERE TRIM(attendee_name) = 'Hassan';
UPDATE amex_line_attendees SET attendee_name = 'Franck Roger'     WHERE TRIM(attendee_name) = 'franck';
UPDATE amex_line_attendees SET attendee_name = 'Steve Kent'       WHERE TRIM(attendee_name) = 'Stephan Kent';

-- ─── Post-verification (run after; expect mismatch = 0 on both tables) ───────
--   SELECT COUNT(*) FROM attendee_directory;   -- expect 73
--   SELECT DISTINCT attendee_name FROM receipt_attendees
--     WHERE TRIM(attendee_name) NOT IN (SELECT name FROM attendee_directory);   -- expect 0
--   SELECT DISTINCT attendee_name FROM amex_line_attendees
--     WHERE TRIM(attendee_name) NOT IN (SELECT name FROM attendee_directory);   -- expect 0
--   SELECT attendee_name FROM receipt_attendees WHERE receipt_id LIKE '650200bf%';
--     -- expect 甲斐澄 and Will Laurent among the six, no romaji leftovers
