-- 0021_export_proofs.sql
--
-- Record the sealed proofs ZIP artifact on each export row.
--
-- Why: the accountant bundle now ships a 5th artifact — the proofs ZIP
-- (exports/<month>/<exportId>-proofs.zip) built at rebuild. Its R2 key + SHA-256
-- are persisted here so (a) the finalize-only route can verify presence exactly
-- like bundle_built_at, (b) the download route (file=proofs) can serve the
-- sealed bytes without re-deriving the key, and (c) the manifest/README can
-- record the SHA for integrity verification.
--
-- Additive only — nullable, no backfill. NULL on rows predating the proofs
-- artifact (e.g. 2026-06 revision 1, sealed without proofs); the download route
-- 404s with a clear message for a missing proofs key.
ALTER TABLE receipt_exports ADD COLUMN proofs_r2_key TEXT;
ALTER TABLE receipt_exports ADD COLUMN proofs_sha256 TEXT;
