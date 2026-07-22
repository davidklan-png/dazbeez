-- 0034_blocked_intake_senders.sql
--
-- Operator-managed blocklist for inbound receipt email (ADR 0011 follow-up
-- 2026-07-22). Mirrors trusted_intake_senders (0029): one row per blocked
-- address, per-entry audit. `email` is lowercase-normalized at write time
-- (shared normalizeSenderEmail), matching the trusted table's convention so
-- the consumer/Worker eligibility checks are plain set-membership tests.
--
-- Mutually exclusive with trusted_intake_senders at the policy layer:
-- trusting a sender removes any blocked row; blocking removes any trusted
-- row. If inconsistent data somehow exists in both tables, blocked wins
-- defensively in every eligibility check.
--
-- Table starts empty; the operator adds blocks via Settings or Inbox.
CREATE TABLE IF NOT EXISTS blocked_intake_senders (
  email TEXT PRIMARY KEY,
  blocked_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Bounded sender-activity queries (Recent unrecognized senders view +
-- latest-attempt-delivery for the blocked-senders list). Covers the common
-- WHERE from_address = ? ORDER BY received_at DESC pattern.
CREATE INDEX IF NOT EXISTS idx_email_intake_from_received
  ON email_receipt_intake (from_address, received_at DESC);
