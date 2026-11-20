-- AMEX editing metadata lives outside financial rows: 0043 seals every line UPDATE.
-- Extends 0047 receipt CAS without changing its shipped triggers.
CREATE TABLE amex_line_revisions (
  line_id TEXT PRIMARY KEY NOT NULL REFERENCES amex_statement_lines(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO amex_line_revisions(line_id) SELECT id FROM amex_statement_lines;
ALTER TABLE business_trip_reports ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991);

-- A business/context invalidation also advances every observing trip's token.
-- Counter-only updates have no reverse trigger: recursive_triggers ON stays finite,
-- and a metadata acknowledgement cannot bless a concurrently changed member view.

-- Always empty. Named constraints turn failed admission into a statement failure,
-- rolling back the entire D1 batch (including roster, receipt consequences and audit).
CREATE TABLE amex_write_assertions (failure TEXT NOT NULL,
  CONSTRAINT amex_line_sealed CHECK(failure <> 'amex_line_sealed'),
  CONSTRAINT amex_line_build_conflict CHECK(failure <> 'amex_line_build_conflict'),
  CONSTRAINT amex_line_missing CHECK(failure <> 'amex_line_missing'),
  CONSTRAINT amex_line_revision_conflict CHECK(failure <> 'amex_line_revision_conflict'),
  CONSTRAINT amex_trip_missing CHECK(failure <> 'amex_trip_missing'),
  CONSTRAINT amex_trip_revision_conflict CHECK(failure <> 'amex_trip_revision_conflict'),
  CONSTRAINT amex_trip_members_conflict CHECK(failure <> 'amex_trip_members_conflict'),
  CONSTRAINT amex_trip_ownership_conflict CHECK(failure <> 'amex_trip_ownership_conflict'),
  CONSTRAINT amex_receipt_missing CHECK(failure <> 'amex_receipt_missing'),
  CONSTRAINT amex_receipt_ineligible CHECK(failure <> 'amex_receipt_ineligible'),
  CONSTRAINT amex_receipt_revision_conflict CHECK(failure <> 'amex_receipt_revision_conflict')
);

CREATE TRIGGER amex_revision_line_insert AFTER INSERT ON amex_statement_lines
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (NEW.business_trip_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (NEW.business_trip_id));
  INSERT INTO amex_line_revisions(line_id) VALUES (NEW.id);
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE matched_receipt_id = NEW.matched_receipt_id AND id != NEW.id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (NEW.business_trip_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE matched_receipt_id = NEW.matched_receipt_id AND id != NEW.id))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE matched_receipt_id = NEW.matched_receipt_id AND id != NEW.id)));
END;

CREATE TRIGGER amex_revision_line_update AFTER UPDATE ON amex_statement_lines
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_id, NEW.business_trip_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (OLD.business_trip_id, NEW.business_trip_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (OLD.business_trip_id, NEW.business_trip_id)) AND OLD.business_trip_id IS NOT NEW.business_trip_id;
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (
    SELECT NEW.id UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.matched_receipt_id, NEW.matched_receipt_id)
    UNION SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_id, NEW.business_trip_id)
      AND OLD.business_trip_id IS NOT NEW.business_trip_id
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_id, NEW.business_trip_id)
      AND OLD.business_trip_id IS NOT NEW.business_trip_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (SELECT OLD.business_trip_id UNION SELECT NEW.business_trip_id UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (OLD.id, NEW.id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (
    SELECT NEW.id UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.matched_receipt_id, NEW.matched_receipt_id)
    UNION SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_id, NEW.business_trip_id)
      AND OLD.business_trip_id IS NOT NEW.business_trip_id
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_id, NEW.business_trip_id)
      AND OLD.business_trip_id IS NOT NEW.business_trip_id))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (
    SELECT NEW.id UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.matched_receipt_id, NEW.matched_receipt_id)
    UNION SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_id, NEW.business_trip_id)
      AND OLD.business_trip_id IS NOT NEW.business_trip_id
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_id, NEW.business_trip_id)
      AND OLD.business_trip_id IS NOT NEW.business_trip_id)));
END;

CREATE TRIGGER amex_revision_line_delete AFTER DELETE ON amex_statement_lines
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (OLD.business_trip_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (OLD.business_trip_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE matched_receipt_id = OLD.matched_receipt_id
    UNION SELECT id FROM amex_statement_lines WHERE business_trip_id = OLD.business_trip_id
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id = OLD.business_trip_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (OLD.business_trip_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE matched_receipt_id = OLD.matched_receipt_id
    UNION SELECT id FROM amex_statement_lines WHERE business_trip_id = OLD.business_trip_id
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id = OLD.business_trip_id))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE matched_receipt_id = OLD.matched_receipt_id
    UNION SELECT id FROM amex_statement_lines WHERE business_trip_id = OLD.business_trip_id
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id = OLD.business_trip_id)));
END;

CREATE TRIGGER amex_revision_attendee_insert AFTER INSERT ON amex_line_attendees
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE id IN (NEW.amex_statement_line_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (NEW.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (SELECT business_trip_id FROM amex_statement_lines WHERE id IN (NEW.amex_statement_line_id) UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (NEW.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (NEW.amex_statement_line_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (NEW.amex_statement_line_id))));
END;

CREATE TRIGGER amex_revision_attendee_update AFTER UPDATE ON amex_line_attendees
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (SELECT business_trip_id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id) UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id))));
END;

CREATE TRIGGER amex_revision_attendee_delete AFTER DELETE ON amex_line_attendees
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (SELECT business_trip_id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id) UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (OLD.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id))));
END;

CREATE TRIGGER amex_revision_trip_context AFTER UPDATE OF trip_name, cardholder_name, start_date, end_date, primary_location, status, purpose, created_at, updated_at ON business_trip_reports
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id=NEW.id
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id=NEW.id
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id=NEW.id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (NEW.id);
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.id))));
END;

CREATE TRIGGER amex_revision_business_trip_report_lines_insert AFTER INSERT ON business_trip_report_lines
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_report_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (NEW.business_trip_report_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (NEW.business_trip_report_id)
    UNION SELECT matched_receipt_id FROM amex_statement_lines WHERE id IN (NEW.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (NEW.business_trip_report_id);
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.business_trip_report_id) UNION SELECT NEW.amex_statement_line_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.business_trip_report_id) UNION SELECT NEW.amex_statement_line_id))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.business_trip_report_id) UNION SELECT NEW.amex_statement_line_id)));
END;

CREATE TRIGGER amex_revision_business_trip_report_lines_update AFTER UPDATE ON business_trip_report_lines
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id)
    UNION SELECT matched_receipt_id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id, NEW.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (OLD.business_trip_report_id, NEW.business_trip_report_id);
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT OLD.amex_statement_line_id UNION SELECT NEW.amex_statement_line_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT OLD.amex_statement_line_id UNION SELECT NEW.amex_statement_line_id))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT OLD.amex_statement_line_id UNION SELECT NEW.amex_statement_line_id)));
END;

CREATE TRIGGER amex_revision_business_trip_report_lines_delete AFTER DELETE ON business_trip_report_lines
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (OLD.business_trip_report_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (OLD.business_trip_report_id)
    UNION SELECT matched_receipt_id FROM amex_statement_lines WHERE id IN (OLD.amex_statement_line_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (OLD.business_trip_report_id);
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id) UNION SELECT OLD.amex_statement_line_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id) UNION SELECT OLD.amex_statement_line_id))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id) UNION SELECT OLD.amex_statement_line_id)));
END;

CREATE TRIGGER amex_revision_business_trip_report_receipts_insert AFTER INSERT ON business_trip_report_receipts
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_report_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (NEW.business_trip_report_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (NEW.business_trip_report_id)
    UNION SELECT NEW.receipt_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (NEW.business_trip_report_id);
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.receipt_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.receipt_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (NEW.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.receipt_id))));
END;

CREATE TRIGGER amex_revision_business_trip_report_receipts_update AFTER UPDATE ON business_trip_report_receipts
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id)
    UNION SELECT OLD.receipt_id UNION SELECT NEW.receipt_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (OLD.business_trip_report_id, NEW.business_trip_report_id);
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id, NEW.receipt_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id, NEW.receipt_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id, NEW.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id, NEW.receipt_id))));
END;

CREATE TRIGGER amex_revision_business_trip_report_receipts_delete AFTER DELETE ON business_trip_report_receipts
BEGIN
  UPDATE receipt_records SET revision=revision+1 WHERE id IN (SELECT matched_receipt_id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id)
    UNION SELECT l.matched_receipt_id FROM amex_statement_lines l JOIN business_trip_report_lines m ON m.amex_statement_line_id=l.id WHERE m.business_trip_report_id IN (OLD.business_trip_report_id)
    UNION SELECT receipt_id FROM business_trip_report_receipts WHERE business_trip_report_id IN (OLD.business_trip_report_id)
    UNION SELECT OLD.receipt_id);
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (OLD.business_trip_report_id);
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE business_trip_id IN (OLD.business_trip_report_id) UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (OLD.business_trip_report_id) UNION SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id))));
END;

CREATE TRIGGER amex_revision_receipt_insert AFTER INSERT ON receipt_records
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.id))));
END;

CREATE TRIGGER amex_revision_receipt_update AFTER UPDATE OF id, captured_at, captured_by, source, original_filename, payment_path, expense_type, transaction_date, merchant, amount_minor, currency, tax_amount_minor, business_purpose, alcohol_present, attendees_required, status, original_r2_key, original_sha256, original_content_type, original_size_bytes, processed_r2_key, extraction_json, legacy, exported_month, created_at, updated_at, deleted_at, deleted_by, delete_reason, expense_category_code, retention_until, legal_hold, source_type, preservation_status, confirmed_at, confirmed_by, invoice_registration_number, invoice_registration_status, qualified_invoice_status, tax_rate, counterparty_name, search_text, compliance_warnings_json, device_id, client_capture_id, captured_at_client, upload_origin, extraction_state, extraction_enqueued_at, extraction_processed_at, extraction_attempts, extraction_processor, export_statement_month, extraction_r2_key, needs_render, extraction_enqueue_failed_at, capture_request_fingerprint ON receipt_records
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.id, NEW.id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.id, NEW.id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.id, NEW.id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.id, NEW.id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.id, NEW.id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.id, NEW.id))));
END;

CREATE TRIGGER amex_revision_receipt_delete AFTER DELETE ON receipt_records
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.id))));
END;

CREATE TRIGGER amex_revision_receipt_attendees_insert AFTER INSERT ON receipt_attendees
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.receipt_id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.receipt_id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.receipt_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.receipt_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.receipt_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.receipt_id))));
END;

CREATE TRIGGER amex_revision_receipt_attendees_update AFTER UPDATE ON receipt_attendees
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.receipt_id, NEW.receipt_id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.receipt_id, NEW.receipt_id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.receipt_id, NEW.receipt_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id, NEW.receipt_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id, NEW.receipt_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id, NEW.receipt_id))));
END;

CREATE TRIGGER amex_revision_receipt_attendees_delete AFTER DELETE ON receipt_attendees
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.receipt_id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.receipt_id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.receipt_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.receipt_id))));
END;

CREATE TRIGGER amex_revision_receipt_files_insert AFTER INSERT ON receipt_files
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.object_id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.object_id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (NEW.object_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.object_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.object_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (NEW.object_id))));
END;

CREATE TRIGGER amex_revision_receipt_files_update AFTER UPDATE ON receipt_files
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.object_id, NEW.object_id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.object_id, NEW.object_id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.object_id, NEW.object_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.object_id, NEW.object_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.object_id, NEW.object_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.object_id, NEW.object_id))));
END;

CREATE TRIGGER amex_revision_receipt_files_delete AFTER DELETE ON receipt_files
BEGIN
  UPDATE amex_line_revisions SET revision=revision+1 WHERE line_id IN (
    SELECT id FROM amex_statement_lines WHERE business_trip_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.object_id))
    UNION SELECT amex_statement_line_id FROM business_trip_report_lines WHERE business_trip_report_id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.object_id)));
  UPDATE business_trip_reports SET revision=revision+1 WHERE id IN (SELECT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id IN (OLD.object_id));
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.object_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.object_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE matched_receipt_id IN (OLD.object_id))));
END;

CREATE TRIGGER amex_revision_artifact_insert AFTER INSERT ON amex_statement_artifacts
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (NEW.id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (NEW.id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (NEW.id))));
END;

CREATE TRIGGER amex_revision_reconciliation_insert AFTER INSERT ON amex_reconciliations
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (NEW.statement_month));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (NEW.statement_month)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (NEW.statement_month))));
END;

CREATE TRIGGER amex_revision_export_item_insert AFTER INSERT ON receipt_export_items
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (NEW.item_id) OR matched_receipt_id IN (NEW.item_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (NEW.item_id) OR matched_receipt_id IN (NEW.item_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (NEW.item_id) OR matched_receipt_id IN (NEW.item_id))));
END;

CREATE TRIGGER amex_revision_directory_insert AFTER INSERT ON attendee_directory
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (NEW.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (NEW.name));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (NEW.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (NEW.name)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (NEW.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (NEW.name))));
END;

CREATE TRIGGER amex_revision_artifact_update AFTER UPDATE ON amex_statement_artifacts
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (OLD.id, NEW.id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (OLD.id, NEW.id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (OLD.id, NEW.id))));
END;

CREATE TRIGGER amex_revision_reconciliation_update AFTER UPDATE ON amex_reconciliations
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (OLD.statement_month, NEW.statement_month));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (OLD.statement_month, NEW.statement_month)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (OLD.statement_month, NEW.statement_month))));
END;

CREATE TRIGGER amex_revision_export_item_update AFTER UPDATE ON receipt_export_items
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.item_id, NEW.item_id) OR matched_receipt_id IN (OLD.item_id, NEW.item_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.item_id, NEW.item_id) OR matched_receipt_id IN (OLD.item_id, NEW.item_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.item_id, NEW.item_id) OR matched_receipt_id IN (OLD.item_id, NEW.item_id))));
END;

CREATE TRIGGER amex_revision_directory_update AFTER UPDATE ON attendee_directory
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (OLD.name, NEW.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (OLD.name, NEW.name));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (OLD.name, NEW.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (OLD.name, NEW.name)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (OLD.name, NEW.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (OLD.name, NEW.name))));
END;

CREATE TRIGGER amex_revision_artifact_delete AFTER DELETE ON amex_statement_artifacts
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (OLD.id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (OLD.id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_artifact_id IN (OLD.id))));
END;

CREATE TRIGGER amex_revision_reconciliation_delete AFTER DELETE ON amex_reconciliations
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (OLD.statement_month));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (OLD.statement_month)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE statement_month IN (OLD.statement_month))));
END;

CREATE TRIGGER amex_revision_export_item_delete AFTER DELETE ON receipt_export_items
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.item_id) OR matched_receipt_id IN (OLD.item_id));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.item_id) OR matched_receipt_id IN (OLD.item_id)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT id FROM amex_statement_lines WHERE id IN (OLD.item_id) OR matched_receipt_id IN (OLD.item_id))));
END;

CREATE TRIGGER amex_revision_directory_delete AFTER DELETE ON attendee_directory
BEGIN
  UPDATE amex_line_revisions SET revision = revision + 1 WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (OLD.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (OLD.name));
  UPDATE business_trip_reports SET revision = revision + 1 WHERE id IN (
    SELECT business_trip_id FROM amex_statement_lines WHERE id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (OLD.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (OLD.name)))
    UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id IN (SELECT line_id FROM amex_line_revisions WHERE line_id IN (SELECT amex_statement_line_id FROM amex_line_attendees WHERE attendee_name IN (OLD.name) UNION SELECT l.id FROM amex_statement_lines l JOIN receipt_attendees a ON a.receipt_id = l.matched_receipt_id WHERE a.attendee_name IN (OLD.name))));
END;
