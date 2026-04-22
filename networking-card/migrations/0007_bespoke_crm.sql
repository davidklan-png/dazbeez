PRAGMA foreign_keys = OFF;

ALTER TABLE contacts RENAME TO contacts_old;
ALTER TABLE contact_methods RENAME TO contact_methods_old;
ALTER TABLE contact_events RENAME TO contact_events_old;
ALTER TABLE notification_failures RENAME TO notification_failures_old;

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_native TEXT,
  website TEXT,
  website_domain TEXT,
  industry TEXT,
  description TEXT,
  size_hint TEXT,
  headquarters TEXT,
  country TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'ingested' CHECK(status IN ('ingested', 'needs_review', 'approved', 'enriched', 'draft_ready', 'merged', 'archived', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT REFERENCES cards(token),
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  full_name_native TEXT,
  furigana TEXT,
  email TEXT,
  email_lower TEXT,
  phone TEXT,
  mobile TEXT,
  linkedin_url TEXT,
  website TEXT,
  website_domain TEXT,
  company TEXT,
  company_name_native TEXT,
  job_title TEXT,
  department TEXT,
  address TEXT,
  postal_code TEXT,
  city TEXT,
  state_prefecture TEXT,
  country TEXT,
  notes TEXT,
  raw_ocr_text TEXT,
  source TEXT NOT NULL CHECK(source IN (
    'google',
    'linkedin',
    'manual',
    'google_oauth',
    'linkedin_oauth',
    'nfc_card',
    'qr_card',
    'manual_form',
    'paper_card_batch_upload',
    'admin_manual_entry'
  )),
  status TEXT NOT NULL DEFAULT 'ingested' CHECK(status IN ('ingested', 'needs_review', 'approved', 'enriched', 'draft_ready', 'merged', 'archived', 'error')),
  source_language TEXT,
  primary_batch_id INTEGER REFERENCES contact_batches(id) ON DELETE SET NULL,
  last_confidence REAL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  machine_summary TEXT,
  human_notes TEXT,
  merged_into_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  cf_country TEXT,
  cf_city TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN (
    'google',
    'linkedin',
    'manual',
    'google_oauth',
    'linkedin_oauth',
    'nfc_card',
    'qr_card',
    'manual_form',
    'paper_card_batch_upload',
    'admin_manual_entry'
  )),
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contact_id, method)
);

CREATE TABLE IF NOT EXISTS contact_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token TEXT REFERENCES cards(token),
  batch_id INTEGER REFERENCES contact_batches(id) ON DELETE SET NULL,
  batch_card_id INTEGER REFERENCES batch_cards(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK(source IN (
    'google',
    'linkedin',
    'manual',
    'google_oauth',
    'linkedin_oauth',
    'nfc_card',
    'qr_card',
    'manual_form',
    'paper_card_batch_upload',
    'admin_manual_entry'
  )),
  event_type TEXT NOT NULL DEFAULT 'contact_captured',
  name TEXT NOT NULL,
  email TEXT,
  summary TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token TEXT REFERENCES cards(token),
  channel TEXT NOT NULL CHECK(channel IN ('discord', 'email')),
  error_message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_card_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES contact_batches(id) ON DELETE CASCADE,
  batch_card_id INTEGER REFERENCES batch_cards(id) ON DELETE CASCADE,
  image_role TEXT NOT NULL CHECK(image_role IN ('batch_original', 'cropped_card', 'enhanced_card')),
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL,
  sha256 TEXT,
  blob_data BLOB NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK(status IN ('uploaded', 'detecting', 'processing', 'needs_review', 'approved', 'completed', 'error', 'archived')),
  event_name TEXT,
  event_date TEXT,
  event_location TEXT,
  notes_about_conversations TEXT,
  campaign_tag TEXT,
  source_filename TEXT,
  source_mime_type TEXT,
  expected_card_count INTEGER,
  detected_card_count INTEGER,
  created_contacts_count INTEGER NOT NULL DEFAULT 0,
  updated_contacts_count INTEGER NOT NULL DEFAULT 0,
  needs_review_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  original_image_id INTEGER REFERENCES business_card_images(id) ON DELETE SET NULL,
  processing_diagnostics_json TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

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

CREATE TABLE IF NOT EXISTS processing_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  batch_id INTEGER REFERENCES contact_batches(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'partial', 'error')),
  attempts INTEGER NOT NULL DEFAULT 0,
  input_json TEXT,
  output_json TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  batch_id INTEGER REFERENCES contact_batches(id) ON DELETE SET NULL,
  before_json TEXT,
  after_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO contacts (
  id,
  token,
  name,
  email,
  email_lower,
  linkedin_url,
  company,
  source,
  status,
  cf_country,
  cf_city,
  user_agent,
  created_at,
  updated_at
)
SELECT
  id,
  token,
  name,
  email,
  lower(email),
  linkedin_url,
  company,
  CASE
    WHEN source = 'google' THEN 'google_oauth'
    WHEN source = 'linkedin' THEN 'linkedin_oauth'
    ELSE 'manual'
  END,
  'approved',
  cf_country,
  cf_city,
  user_agent,
  created_at,
  created_at
FROM contacts_old;

INSERT INTO contact_methods (
  id,
  contact_id,
  method,
  created_at
)
SELECT
  id,
  contact_id,
  CASE
    WHEN method = 'google' THEN 'google_oauth'
    WHEN method = 'linkedin' THEN 'linkedin_oauth'
    ELSE 'manual'
  END,
  created_at
FROM contact_methods_old;

INSERT INTO contact_events (
  id,
  contact_id,
  token,
  source,
  event_type,
  name,
  email,
  created_at
)
SELECT
  id,
  contact_id,
  token,
  CASE
    WHEN source = 'google' THEN 'google_oauth'
    WHEN source = 'linkedin' THEN 'linkedin_oauth'
    ELSE 'manual'
  END,
  'contact_captured',
  name,
  email,
  created_at
FROM contact_events_old;

INSERT INTO notification_failures (
  id,
  contact_id,
  token,
  channel,
  error_message,
  payload_json,
  created_at
)
SELECT
  id,
  contact_id,
  token,
  channel,
  error_message,
  payload_json,
  created_at
FROM notification_failures_old;

DROP TABLE contacts_old;
DROP TABLE contact_methods_old;
DROP TABLE contact_events_old;
DROP TABLE notification_failures_old;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_domain
  ON companies(name, COALESCE(website_domain, ''));
CREATE INDEX IF NOT EXISTS idx_companies_website_domain ON companies(website_domain);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

CREATE INDEX IF NOT EXISTS idx_contacts_token ON contacts(token);
CREATE INDEX IF NOT EXISTS idx_contacts_email_lower ON contacts(email_lower);
CREATE INDEX IF NOT EXISTS idx_contacts_linkedin_url ON contacts(linkedin_url);
CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_primary_batch_id ON contacts(primary_batch_id);

CREATE INDEX IF NOT EXISTS idx_contact_methods_contact_id ON contact_methods(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_contact_id ON contact_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_token ON contact_events(token);
CREATE INDEX IF NOT EXISTS idx_contact_events_batch_id ON contact_events(batch_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_created_at ON contact_events(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_failures_contact_id ON notification_failures(contact_id);
CREATE INDEX IF NOT EXISTS idx_notification_failures_created_at ON notification_failures(created_at);

CREATE INDEX IF NOT EXISTS idx_business_card_images_batch_id ON business_card_images(batch_id);
CREATE INDEX IF NOT EXISTS idx_business_card_images_batch_card_id ON business_card_images(batch_card_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_card_images_storage_key ON business_card_images(storage_key);

CREATE INDEX IF NOT EXISTS idx_contact_batches_status ON contact_batches(status);
CREATE INDEX IF NOT EXISTS idx_contact_batches_event_date ON contact_batches(event_date);
CREATE INDEX IF NOT EXISTS idx_contact_batches_created_at ON contact_batches(created_at);

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
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status ON processing_jobs(status);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_batch_id ON processing_jobs(batch_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);

INSERT OR IGNORE INTO admin_settings (key, value_json)
VALUES (
  'dazbeez_profile',
  '{
    "my_name": "David Klan",
    "my_title": "AI, Automation & Data Consultant / IT PM + AI/ML Engineer",
    "my_company": "Dazbeez G.K.",
    "my_company_summary": "Dazbeez builds AI, automation, and data systems designed to stay correct, auditable, testable, and maintainable over time, especially where Japanese regulatory, bilingual, or operational constraints are real.",
    "my_personal_summary": "David Klan is a curiosity-driven builder who uses AI to help experts do meaningful work. He brings 15+ years spanning software engineering, consulting, enterprise transformation, document-heavy workflows, and cross-cultural work across Japan and the US.",
    "my_services": ["AI integration", "workflow automation", "data management", "governance", "project management", "LLM applications", "RAG systems", "document OCR workflows", "change enablement"],
    "my_target_industries": ["insurance", "finance", "professional services", "education", "logistics", "Japan-regulated businesses", "document-heavy operations", "Hawaii-based businesses"],
    "my_value_props": [
      "Builds systems that survive real constraints instead of demo-only prototypes",
      "Creates auditable and explainable AI with source grounding and review paths",
      "Automates repetitive work while preserving human judgment",
      "Designs maintainable hand-offs for small teams",
      "Works well in bilingual and cross-cultural business contexts",
      "Can connect technical delivery, governance, and change enablement"
    ],
    "my_case_studies": [
      {
        "name": "Japanese Tax Expert System (JTES)",
        "summary": "Citation-grounded AI assistant for Japanese tax professionals using official sources and trustworthy retrieval.",
        "tags": ["RAG", "citation-grounding", "Japanese tax", "expert workflow", "trustworthy AI"]
      },
      {
        "name": "Insurance Reporting & Incident Intelligence",
        "summary": "Automation and intelligence workflows that improved reporting consistency, executive visibility, and operational decision-making.",
        "tags": ["insurance", "reporting automation", "incident intelligence", "executive visibility"]
      },
      {
        "name": "Receipt Classification & Matching System",
        "summary": "Document understanding workflow to classify receipts and support reconciliation with a practical mix of rules and ML.",
        "tags": ["OCR", "document AI", "finance ops", "classification", "reconciliation"]
      },
      {
        "name": "Enterprise Data Migration / Infrastructure Transformation",
        "summary": "Large-scale enterprise delivery spanning migration, governance, infrastructure standardization, and stakeholder coordination.",
        "tags": ["enterprise transformation", "governance", "project management", "risk reduction"]
      }
    ],
    "my_company_website": "https://dazbeez.com",
    "my_personal_website": "https://kinokoholic.com",
    "my_linkedin": "https://www.linkedin.com/in/david-klan",
    "my_discord_invite": "",
    "preferred_email_tone": "warm, intelligent, concise, practical, non-hype, non-spam, specific, human",
    "default_call_to_action": "Invite a practical follow-up conversation, partnership discussion, or simple ongoing connection depending on fit."
  }'
);

INSERT OR IGNORE INTO admin_settings (key, value_json)
VALUES (
  'crm_thresholds',
  '{
    "ocr_review_threshold": 0.72,
    "dedupe_review_threshold": 0.75,
    "draft_review_threshold": 0.7,
    "detection_min_cards": 6
  }'
);

INSERT OR IGNORE INTO admin_settings (key, value_json)
VALUES (
  'crm_integrations',
  '{
    "vision_provider": "cloudflare_ai",
    "text_provider": "cloudflare_ai",
    "search_provider": "website_fetch",
    "discord_notifications_enabled": false,
    "provider_secret_strategy": "environment_variables"
  }'
);

PRAGMA foreign_keys = ON;
