# Incident: NFC card capture outage — ghost FK from migration 0009 (2026-08-26)

One page. Its job: stop someone deleting the shim or reaching for
`d1 migrations apply` six months from now.

## Symptom

Every NFC card capture failed with 503 — Google sign-in, LinkedIn sign-in,
and the manual form. The visitor saw "Your details could not be saved right
now." The `contacts` row was still saved (it is written before the failing
statement), so no contact data was lost, but no `contact_events` row could be
written and the visitor believed the capture failed.

## Root cause

Migration `0009_repair_contact_foreign_keys.sql` rebuilt `batch_cards` by
renaming it to `batch_cards_old_fk_repair`, recreating it, copying, and
dropping the temp. Since SQLite 3.25, `ALTER TABLE … RENAME TO` rewrites
`REFERENCES` clauses in *other* tables to follow the rename — and
`PRAGMA foreign_keys = OFF` does not suppress that. So `contact_events` and
`business_card_images` silently acquired FKs pointing at
`batch_cards_old_fk_repair`, which `0009:343` then dropped. Every
`INSERT INTO contact_events` failed at statement-prepare time with
`D1_ERROR: no such table: main.batch_cards_old_fk_repair` — a *resolution*
failure, not a constraint failure, and one that `PRAGMA foreign_key_check`
cannot see (it validates rows, not schema targets; all child keys are NULL).

## Timeline

- **2026-05-20 05:41 UTC (14:41 JST):** an undocumented
  `wrangler d1 migrations apply` backfill ran migrations 0001–0011 against
  production `dazbeez-networking` in two runs 29 s apart. This executed
  0009's rename-rebuild-drops and armed the ghost FKs.
- **Last successful `contact_events` write:** 2026-05-15 (id 29).
- **2026-06-11 / 2026-06-30:** the only two real visitors in the window hit
  the broken page (contacts saved, events lost — see follow-up file).
- **2026-08-26:** first sustained use since June exposed the outage.
  Hotfix branch `hotfix/nfc-save-logging` (commit `6a8714d`) added
  `console.error` to the three swallowed catch blocks; deployed to production
  Pages (deployment `53ccc56d`); a `wrangler pages deployment tail` captured
  the exact D1 error on both routes.
- **2026-08-26 ~12:05 UTC:** shim applied, both routes verified writing
  (`contact_events` ids 30 google / 31 manual, token `LKcinWR9`).

## The fix that is currently live (the shim)

Production contains an **empty stub table**:

```sql
CREATE TABLE IF NOT EXISTS batch_cards_old_fk_repair (id INTEGER PRIMARY KEY);
```

The runtime error is a table-resolution failure, so making the parent exist
resolves it. Nothing in the live capture path ever writes a non-NULL
`batch_card_id`, so the stub is never read. **Do not drop it until 0013 AND
0014 have both been applied** — dropping it first re-breaks all capture.
Documented in `docs/nfc-module.md` ("KNOWN SCHEMA DEBT").

## What the real repair must do

Drafts (NOT applied, rehearsal required) live at
`networking-card/migrations/0013_repair_contact_events_ghost_fk.sql` and
`0014_repair_business_card_images_ghost_fk.sql`. Requirements of record:
explicit column lists (no `SELECT *`); D1 Time Travel bookmark before any
DROP; rehearse on local scratch D1 with the real DDL and row counts; fix both
tables in one maintenance window; deliver via `d1 execute --file` — **never
`d1 migrations apply`**.

## Affected visitors (2026-05-20 → 2026-08-26)

| contact id | name | email | date (UTC) | what they experienced |
|---|---|---|---|---|
| 24 | non mi | n.mise@sekia.net | 2026-06-11 07:09 | Google sign-in → "Your details could not be saved" — but their info WAS saved |
| 25 | Jatin Lalit | jatinlalit9@gmail.com | 2026-06-30 05:15 | same |

David contacted both visitors on 2026-08-26 — follow-up closed. See
`docs/incidents/2026-08-26-nfc-orphan-contact-followup.md`.

## Additional findings recorded during close-out (not acted on)

- **A third ghost FK exists:** `email_reply_ingest_log.contact_id REFERENCES
  "contacts_old"(id)` — `contacts_old` does not exist in production. Different
  origin, same bug class, on the dropped-CRM email-ingest path. Any
  ghost-FK detector (compare `PRAGMA foreign_key_list` targets against
  `sqlite_master`) should be written to catch all three.
- `0012_mobile_capture.sql` is in the repo but **not applied** to production.
- The `_v2` tables created by `0010` (`contact_events_v2`,
  `business_card_images_v2`, `business_card_image_objects_v2`) were an escape
  hatch never wired into code. Dead weight; decide their fate when 0013/0014
  land. Note `email_reply_ingest_log.event_id` references
  `contact_events_v2(id)` — do not drop that table without checking it.
- `saveContact` performs three non-atomic writes (`contacts` →
  `contact_methods` → `contact_events`); a failure at step three orphans the
  contact row. Candidate fix: a D1 batch.
