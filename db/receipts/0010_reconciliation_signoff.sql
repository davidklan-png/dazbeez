CREATE TABLE IF NOT EXISTS amex_reconciliations (
  id TEXT PRIMARY KEY,
  statement_month TEXT NOT NULL,
  statement_artifact_id TEXT REFERENCES amex_statement_artifacts(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'finalized')),
  manifest_r2_key TEXT,
  manifest_sha256 TEXT,
  line_count INTEGER NOT NULL,
  matched_count INTEGER NOT NULL,
  no_receipt_count INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_by TEXT,
  finalized_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_amex_reconciliations_month_finalized
  ON amex_reconciliations(statement_month) WHERE status = 'finalized';

CREATE INDEX IF NOT EXISTS idx_amex_reconciliations_month
  ON amex_reconciliations(statement_month);
