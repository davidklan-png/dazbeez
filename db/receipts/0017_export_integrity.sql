-- 0017_export_integrity.sql
--
-- Export bundle integrity + per-item audit trail. Audit 2026-07-08 (A3).
-- Additive only — no existing column is altered or dropped.
--
-- What this enables:
--   * At most one draft export per month (`idx_exports_one_draft`). Without
--     this, two POSTs racing createExport() could insert two drafts for the
--     same month and the manifest pointer in createExportRevision() would
--     pick arbitrarily between them.
--   * At most one export row per (month, revision) pair
--     (`idx_exports_month_revision`). Revisions are a monotone chain; the
--     pair is the natural key.
--   * `receipt_export_items` records exactly which receipts and AMEX lines
--     shipped in each export. Today only the CSV knows, which is not
--     queryable for audit ("did receipt X ever ship?") and forces a
--     per-bundle R2 fetch to answer. The (export_id, item_type, item_id)
--     UNIQUE enforces no double-counting inside one bundle.

-- ── Uniqueness on receipt_exports ────────────────────────────────────────────
-- Both indexes are safe to apply to existing rows: revisions default to 1
-- for rows pre-dating migration 0014, and at most one finalized row per
-- (month, revision) exists in current data. A draft + finalized revision
-- chain does not collide because finalized revisions are ≥1 and a fresh
-- draft (revision 1) only coexists with finalized rows when the month has
-- no prior finalized export.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exports_month_revision
  ON receipt_exports(export_month, export_revision);

-- At most one draft per month. SQLite partial unique indexes ignore rows
-- that don't match the WHERE clause, so finalized rows don't count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exports_one_draft
  ON receipt_exports(export_month)
  WHERE status = 'draft';

-- ── receipt_export_items ─────────────────────────────────────────────────────
-- One row per item (receipt or AMEX line) that went into a specific export
-- bundle. Populated at bundle-build time (A4 row-assembly builder) and
-- consulted by finalizeExport to mark receipts status='exported' (A5).
CREATE TABLE IF NOT EXISTS receipt_export_items (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL REFERENCES receipt_exports(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('receipt', 'amex_line')),
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(export_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_export_items_export
  ON receipt_export_items(export_id);

-- Reverse lookup: "which exports has this receipt/line shipped in?" Used by
-- the cross-month finalize gate (A7) and any future "is this row already
-- exported" surface.
CREATE INDEX IF NOT EXISTS idx_export_items_item
  ON receipt_export_items(item_type, item_id);
