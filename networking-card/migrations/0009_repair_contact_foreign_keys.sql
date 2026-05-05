PRAGMA foreign_keys = OFF;

ALTER TABLE enrichment_facts RENAME TO enrichment_facts_old_fk_repair;
ALTER TABLE enrichment_runs RENAME TO enrichment_runs_old_fk_repair;
ALTER TABLE synergy_analyses RENAME TO synergy_analyses_old_fk_repair;
ALTER TABLE email_drafts RENAME TO email_drafts_old_fk_repair;
ALTER TABLE review_tasks RENAME TO review_tasks_old_fk_repair;
ALTER TABLE batch_cards RENAME TO batch_cards_old_fk_repair;

CREATE TABLE IF NOT EXISTS batch_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES contact_batches(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'detected' CHECK(status IN ('detected', 'extracted', 'needs_review', 'approved', 'invalid', 'upserted', 'error')),
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  source_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  cropped_image_id INTEGER REFERENCES business_card_images(id) ON DELETE SET NULL,
  enhanced_image_id INTEGER REFERENCES business_card_images(id) ON DELETE SET NULL,
  detection_label TEXT,
  detection_confidence REAL,
  detection_box_json TEXT,
  transform_json TEXT,
  extraction_provider TEXT,
  raw_ocr_text TEXT,
  extracted_json TEXT,
  normalized_json TEXT,
  confidence_json TEXT,
  duplicate_candidates_json TEXT,
  notes TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO batch_cards (
  id,
  batch_id,
  sort_order,
  status,
  contact_id,
  company_id,
  source_contact_id,
  cropped_image_id,
  enhanced_image_id,
  detection_label,
  detection_confidence,
  detection_box_json,
  transform_json,
  extraction_provider,
  raw_ocr_text,
  extracted_json,
  normalized_json,
  confidence_json,
  duplicate_candidates_json,
  notes,
  needs_review,
  invalid_reason,
  approved_by,
  approved_at,
  created_at,
  updated_at
)
SELECT
  id,
  batch_id,
  sort_order,
  status,
  contact_id,
  company_id,
  source_contact_id,
  cropped_image_id,
  enhanced_image_id,
  detection_label,
  detection_confidence,
  detection_box_json,
  transform_json,
  extraction_provider,
  raw_ocr_text,
  extracted_json,
  normalized_json,
  confidence_json,
  duplicate_candidates_json,
  notes,
  needs_review,
  invalid_reason,
  approved_by,
  approved_at,
  created_at,
  updated_at
FROM batch_cards_old_fk_repair;

CREATE TABLE IF NOT EXISTS enrichment_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  batch_card_id INTEGER REFERENCES batch_cards(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'partial', 'error')),
  request_payload_json TEXT,
  response_payload_json TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO enrichment_runs (
  id,
  contact_id,
  company_id,
  batch_card_id,
  provider,
  status,
  request_payload_json,
  response_payload_json,
  error_message,
  started_at,
  completed_at,
  created_at
)
SELECT
  id,
  contact_id,
  company_id,
  batch_card_id,
  provider,
  status,
  request_payload_json,
  response_payload_json,
  error_message,
  started_at,
  completed_at,
  created_at
FROM enrichment_runs_old_fk_repair;

CREATE TABLE IF NOT EXISTS enrichment_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER REFERENCES enrichment_runs(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  fact_type TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT,
  source_url TEXT NOT NULL,
  source_title TEXT,
  source_snippet TEXT,
  evidence_strength TEXT NOT NULL DEFAULT 'medium' CHECK(evidence_strength IN ('low', 'medium', 'high')),
  retrieved_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO enrichment_facts (
  id,
  run_id,
  contact_id,
  company_id,
  fact_type,
  label,
  value,
  normalized_value,
  source_url,
  source_title,
  source_snippet,
  evidence_strength,
  retrieved_at,
  created_at
)
SELECT
  id,
  run_id,
  contact_id,
  company_id,
  fact_type,
  label,
  value,
  normalized_value,
  source_url,
  source_title,
  source_snippet,
  evidence_strength,
  retrieved_at,
  created_at
FROM enrichment_facts_old_fk_repair;

CREATE TABLE IF NOT EXISTS synergy_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  batch_card_id INTEGER REFERENCES batch_cards(id) ON DELETE SET NULL,
  profile_version TEXT NOT NULL,
  synergy_score INTEGER NOT NULL,
  synergy_summary TEXT NOT NULL,
  suggested_outreach_angle TEXT,
  recommended_cta TEXT,
  reasons_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO synergy_analyses (
  id,
  contact_id,
  company_id,
  batch_card_id,
  profile_version,
  synergy_score,
  synergy_summary,
  suggested_outreach_angle,
  recommended_cta,
  reasons_json,
  evidence_json,
  created_at
)
SELECT
  id,
  contact_id,
  company_id,
  batch_card_id,
  profile_version,
  synergy_score,
  synergy_summary,
  suggested_outreach_angle,
  recommended_cta,
  reasons_json,
  evidence_json,
  created_at
FROM synergy_analyses_old_fk_repair;

CREATE TABLE IF NOT EXISTS email_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  batch_id INTEGER REFERENCES contact_batches(id) ON DELETE SET NULL,
  batch_card_id INTEGER REFERENCES batch_cards(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'needs_review' CHECK(status IN ('needs_review', 'ready', 'approved', 'archived')),
  subject_line TEXT NOT NULL,
  plain_text_body TEXT NOT NULL,
  html_body TEXT,
  rationale_summary TEXT NOT NULL,
  generation_provider TEXT,
  generation_version TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO email_drafts (
  id,
  contact_id,
  company_id,
  batch_id,
  batch_card_id,
  status,
  subject_line,
  plain_text_body,
  html_body,
  rationale_summary,
  generation_provider,
  generation_version,
  approved_by,
  approved_at,
  created_at,
  updated_at
)
SELECT
  id,
  contact_id,
  company_id,
  batch_id,
  batch_card_id,
  status,
  subject_line,
  plain_text_body,
  html_body,
  rationale_summary,
  generation_provider,
  generation_version,
  approved_by,
  approved_at,
  created_at,
  updated_at
FROM email_drafts_old_fk_repair;

CREATE TABLE IF NOT EXISTS review_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  batch_id INTEGER REFERENCES contact_batches(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
  title TEXT NOT NULL,
  detail_json TEXT,
  assigned_to TEXT,
  resolution_note TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO review_tasks (
  id,
  entity_type,
  entity_id,
  batch_id,
  contact_id,
  company_id,
  task_type,
  priority,
  status,
  title,
  detail_json,
  assigned_to,
  resolution_note,
  resolved_at,
  created_at
)
SELECT
  id,
  entity_type,
  entity_id,
  batch_id,
  contact_id,
  company_id,
  task_type,
  priority,
  status,
  title,
  detail_json,
  assigned_to,
  resolution_note,
  resolved_at,
  created_at
FROM review_tasks_old_fk_repair;

DROP TABLE batch_cards_old_fk_repair;
DROP TABLE enrichment_facts_old_fk_repair;
DROP TABLE enrichment_runs_old_fk_repair;
DROP TABLE synergy_analyses_old_fk_repair;
DROP TABLE email_drafts_old_fk_repair;
DROP TABLE review_tasks_old_fk_repair;

CREATE INDEX IF NOT EXISTS idx_batch_cards_batch_id ON batch_cards(batch_id);
CREATE INDEX IF NOT EXISTS idx_batch_cards_contact_id ON batch_cards(contact_id);
CREATE INDEX IF NOT EXISTS idx_batch_cards_company_id ON batch_cards(company_id);
CREATE INDEX IF NOT EXISTS idx_batch_cards_status ON batch_cards(status);
CREATE INDEX IF NOT EXISTS idx_batch_cards_needs_review ON batch_cards(needs_review);

CREATE INDEX IF NOT EXISTS idx_enrichment_runs_contact_id ON enrichment_runs(contact_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_company_id ON enrichment_runs(company_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_status ON enrichment_runs(status);
CREATE INDEX IF NOT EXISTS idx_enrichment_facts_contact_id ON enrichment_facts(contact_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_facts_company_id ON enrichment_facts(company_id);

CREATE INDEX IF NOT EXISTS idx_synergy_analyses_contact_id ON synergy_analyses(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_drafts_contact_id ON email_drafts(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_drafts_status ON email_drafts(status);
CREATE INDEX IF NOT EXISTS idx_review_tasks_status ON review_tasks(status);
CREATE INDEX IF NOT EXISTS idx_review_tasks_contact_id ON review_tasks(contact_id);

PRAGMA foreign_keys = ON;
