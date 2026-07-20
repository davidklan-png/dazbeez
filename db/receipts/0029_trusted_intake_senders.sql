-- 0029_trusted_intake_senders.sql
--
-- ADR 0011 Phase B follow-up: move the email-body auto-promote allowlist out
-- of the TRUSTED_INTAKE_SENDERS env var (consumer.py) and into the app, managed
-- from a Settings page. Mirrors the trusted_devices shape (one row per entry,
-- per-entry audit) — receipt_settings is a single-row-per-scalar-key store,
-- wrong shape for a list with individual add/remove.
--
-- `email` is the PRIMARY KEY → natural dedup (re-adding an address is a no-op),
-- no separate unique index needed. Emails are stored lowercase-normalized at
-- write time (addTrustedSender), so the consumer's eligibility check is a plain
-- set-membership test with no case-folding at read time. Table starts empty;
-- David adds his forwarding address via the UI after deploy.
CREATE TABLE IF NOT EXISTS trusted_intake_senders (
  email TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
