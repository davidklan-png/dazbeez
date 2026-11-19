-- Receipt aggregate tokens are independent of timestamps and bundle fingerprints.
ALTER TABLE receipt_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 0
  CHECK (revision >= 0 AND revision <= 9007199254740991);

-- A failing admission is a statement error, so D1 rolls back the WHOLE batch.
-- The transient row deletes itself; no lease or durable application lock exists.
CREATE TABLE receipt_edit_admissions (receipt_id TEXT NOT NULL, expected_revision INTEGER NOT NULL);
CREATE TRIGGER receipt_edit_admit BEFORE INSERT ON receipt_edit_admissions
WHEN NOT EXISTS (SELECT 1 FROM receipt_records
  WHERE id=NEW.receipt_id AND revision=NEW.expected_revision AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'DZ_RECEIPT_REVISION_CONFLICT'); END;
CREATE TRIGGER receipt_edit_admitted AFTER INSERT ON receipt_edit_admissions
BEGIN
  -- An admitted empty/empty-roster save also consumes its token, without
  -- fabricating a field-change audit. Child triggers may advance it further.
  UPDATE receipt_records SET revision=revision+1 WHERE id=NEW.receipt_id;
  DELETE FROM receipt_edit_admissions WHERE rowid=NEW.rowid;
END;

-- Every existing receipt writer, including timestamp-only duplicate operations.
-- UPDATE OF excludes revision so related-table invalidation cannot recurse.
CREATE TRIGGER receipt_revision_update AFTER UPDATE OF
  id, captured_at, captured_by, source, original_filename,
  payment_path, expense_type, transaction_date, merchant, amount_minor,
  currency, tax_amount_minor, business_purpose, alcohol_present, attendees_required,
  status, original_r2_key, original_sha256, original_content_type, original_size_bytes,
  processed_r2_key, extraction_json, legacy, exported_month, created_at,
  updated_at, deleted_at, deleted_by, delete_reason, expense_category_code,
  retention_until, legal_hold, source_type, preservation_status, confirmed_at,
  confirmed_by, invoice_registration_number, invoice_registration_status, qualified_invoice_status, tax_rate,
  counterparty_name, search_text, compliance_warnings_json, device_id, client_capture_id,
  captured_at_client, upload_origin, extraction_state, extraction_enqueued_at, extraction_processed_at,
  extraction_attempts, extraction_processor, export_statement_month, extraction_r2_key, needs_render,
  extraction_enqueue_failed_at, capture_request_fingerprint ON receipt_records
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id=NEW.id; END;

CREATE TRIGGER receipt_revision_receipt_attendees_insert AFTER INSERT ON receipt_attendees
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (NEW.receipt_id); END;

CREATE TRIGGER receipt_revision_receipt_attendees_update AFTER UPDATE ON receipt_attendees
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (OLD.receipt_id, NEW.receipt_id); END;

CREATE TRIGGER receipt_revision_receipt_attendees_delete AFTER DELETE ON receipt_attendees
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (OLD.receipt_id); END;

CREATE TRIGGER receipt_revision_amex_statement_lines_insert AFTER INSERT ON amex_statement_lines
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (NEW.matched_receipt_id); END;

CREATE TRIGGER receipt_revision_amex_statement_lines_update AFTER UPDATE ON amex_statement_lines
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (OLD.matched_receipt_id, NEW.matched_receipt_id); END;

CREATE TRIGGER receipt_revision_amex_statement_lines_delete AFTER DELETE ON amex_statement_lines
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (OLD.matched_receipt_id); END;

CREATE TRIGGER receipt_revision_receipt_files_insert AFTER INSERT ON receipt_files
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (CASE WHEN NEW.object_type='receipt' THEN NEW.object_id END); END;

CREATE TRIGGER receipt_revision_receipt_files_update AFTER UPDATE ON receipt_files
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (CASE WHEN OLD.object_type='receipt' THEN OLD.object_id END, CASE WHEN NEW.object_type='receipt' THEN NEW.object_id END); END;

CREATE TRIGGER receipt_revision_receipt_files_delete AFTER DELETE ON receipt_files
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (CASE WHEN OLD.object_type='receipt' THEN OLD.object_id END); END;

CREATE TRIGGER receipt_revision_receipt_export_items_insert AFTER INSERT ON receipt_export_items
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (CASE WHEN NEW.item_type='receipt' THEN NEW.item_id END); END;

CREATE TRIGGER receipt_revision_receipt_export_items_update AFTER UPDATE ON receipt_export_items
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (CASE WHEN OLD.item_type='receipt' THEN OLD.item_id END, CASE WHEN NEW.item_type='receipt' THEN NEW.item_id END); END;

CREATE TRIGGER receipt_revision_receipt_export_items_delete AFTER DELETE ON receipt_export_items
BEGIN UPDATE receipt_records SET revision=revision+1 WHERE id IN (CASE WHEN OLD.item_type='receipt' THEN OLD.item_id END); END;
