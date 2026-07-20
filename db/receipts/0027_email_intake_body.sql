-- 0027_email_intake_body.sql
--
-- Phase A of ADR 0011 body capture: store the parsed email body so the
-- operator can read body-only receipts and click verification links (e.g. the
-- Gmail forwarding confirmation) from /receipts/inbox.
--
-- Both body columns are nullable: older rows predate them (NULL), and an email
-- with no text/html part stores NULL. They are capped at capture time
-- (INTAKE_BODY_TEXT_MAX_BYTES / INTAKE_BODY_HTML_MAX_BYTES in
-- lib/receipts/email-intake.ts); body_truncated is set to 1 if EITHER was cut,
-- so the UI can show "body truncated at capture" rather than look silently
-- incomplete.
--
-- Intake-side metadata only. Does NOT flow into receipt_records on promote, and
-- does NOT make body-only receipts promotable in Phase A — promotion stays
-- attachment-only (assertPromotable unchanged). body_html is stored for Phase B
-- (possible body→PDF promotion) but is only ever rendered in Phase A inside a
-- sandboxed iframe with DOMPurify (never injected into the app DOM).
ALTER TABLE email_receipt_intake ADD COLUMN body_text TEXT;
ALTER TABLE email_receipt_intake ADD COLUMN body_html TEXT;
ALTER TABLE email_receipt_intake ADD COLUMN body_truncated INTEGER NOT NULL DEFAULT 0;
