ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Attendee data fix (operator-supplied) — live D1, one audited pass

The operator supplied canonical names, companies, and titles for the 10
unresolved attendee names from your earlier audit. This task is a DATA
change on live `dazbeez-receipts` (RECEIPTS_DB) plus one committed script
file for provenance. No application code changes.

Direct SQL is the sanctioned path here: the sealed-month receipt rows
cannot be edited via any API (your own Part 3 finding), and doing all
rows in one scripted pass beats a mixed UI/SQL cleanup. Provenance = the
committed script + your report.

## 1. Create the script file (commit it)

`db/receipts/scripts/2026-07-17-attendee-data-fix.sql` containing all
statements below, with a header comment referencing the business-manager
review comment and this prompt. Commit + push to master (single small
commit, message `receipts: attendee data fix — register 7, rename receipt rows, correct directory id 19`).
Working-tree hard rules apply: commit ONLY this file, no destructive git.

## 2. Pre-checks (run first; abort and report if any fails)

- `SELECT COUNT(*) FROM attendee_directory;` → must be 66.
- No collisions with the new names:
  `SELECT name FROM attendee_directory WHERE name IN ('甲斐澄','Will Laurent','Colin Hilchey','Viju Vincent','Hassan Musa','Franck Roger','Rhonda Lundin','Steve Kent');`
  → must return 0 rows.
- `SELECT id, name FROM attendee_directory WHERE id = 19;` → must be
  'Stephan Kent'.

## 3. Directory registrations (7 inserts, id omitted → auto rowid)

Use a fixed timestamp literal `'2026-07-17T00:00:00.000Z'` for
created_at/updated_at on all rows.

| Name | Company | Title |
|------|---------|-------|
| 甲斐澄 | AIG Technologies KK | Project Manager |
| Will Laurent | BMW | Data Scientist |
| Colin Hilchey | Morgan Stanley | Sr Engineer |
| Viju Vincent | AIG Technologies KK | Infra Tech Lead |
| Hassan Musa | Bank of America | System Analyst |
| Franck Roger | Bank of America | System Analyst |
| Rhonda Lundin | Lawyers Association | Chief Coordinator |

(Company for 甲斐澄 / Viju Vincent is deliberately the existing directory
form "AIG Technologies KK", operator-approved normalization of "AIG".)

## 4. Directory correction (id 19)

Operator: "Steve Kent is his actual name, he may have been mislabeled as
Stephan." Fix the directory, not the receipts:

```sql
UPDATE attendee_directory
SET name = 'Steve Kent', updated_at = '2026-07-17T00:00:00.000Z'
WHERE id = 19 AND name = 'Stephan Kent';
```

Company/title (FMP Connect KK / President) unchanged.

## 5. Receipt-row renames (global by name, TRIM-matched, all months —
including the sealed June receipt; that is intended)

```sql
UPDATE receipt_attendees SET attendee_name = '甲斐澄'          WHERE TRIM(attendee_name) = 'Kai kiyoshi';
UPDATE receipt_attendees SET attendee_name = 'クランデイビット' WHERE TRIM(attendee_name) = 'David Klan';
UPDATE receipt_attendees SET attendee_name = '村上多寿子'       WHERE TRIM(attendee_name) = 'Tazuko Murakami';
UPDATE receipt_attendees SET attendee_name = 'Hassan Musa'      WHERE TRIM(attendee_name) = 'Hassan';
UPDATE receipt_attendees SET attendee_name = 'Franck Roger'     WHERE TRIM(attendee_name) = 'franck';
UPDATE receipt_attendees SET attendee_name = 'Steve Kent'       WHERE TRIM(attendee_name) = 'Stephan Kent';
```

Run the same six against `amex_line_attendees` for completeness (your
audit showed it clean, so expect 0 changes — report the counts anyway).
Rows already reading 'Will Laurent', 'Colin Hilchey', 'Viju Vincent',
'Rhonda Lundin', 'Steve Kent' are correct as recorded — do not touch.

## 6. Post-verification (report raw output)

- `SELECT COUNT(*) FROM attendee_directory;` → 73.
- Changed-row counts per UPDATE (wrangler reports them).
- The full mismatch query from the original audit against BOTH
  `receipt_attendees` and `amex_line_attendees` → must return 0 rows each:
  `SELECT DISTINCT attendee_name FROM receipt_attendees WHERE TRIM(attendee_name) NOT IN (SELECT name FROM attendee_directory);`
- Spot-check the sealed receipt:
  `SELECT attendee_name FROM receipt_attendees WHERE receipt_id LIKE '650200bf%';`
  → expect 甲斐澄 and Will Laurent among the six, no romaji leftovers.

## Out of scope — do not do

- No June revision, rebuild, or finalize — the operator does that in the
  browser after your report (correction reason: "Add attendee
  company/title per business manager review").
- No application code changes, no new migration number (this is a data
  fix script, not schema).
- No audit_log inserts — the committed script + this report are the
  provenance record.

## Report back

Commit SHA, pre-check outputs, per-statement changed-row counts, all
post-verification outputs verbatim, and anything unexpected (e.g. a
pre-check failure or a rename matching more rows than the audit
predicted).
