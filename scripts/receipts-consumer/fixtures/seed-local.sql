-- Seed for the backfill_proof_copies.py --local dry-run demo (PR 1).
-- Inserts sample receipt_records + one receipt_files proof_copy row into LOCAL
-- D1 only. NEVER run against remote — this is a demo fixture, not real data.
--
-- Apply (Mac):
--   npx wrangler d1 migrations apply RECEIPTS_DB --local
--   npx wrangler d1 execute RECEIPTS_DB --local --file=scripts/receipts-consumer/fixtures/seed-local.sql
--   cd scripts/receipts-consumer && .venv/bin/python3 backfill_proof_copies.py --local --dry-run
--
-- Three receipts:
--   rec-1  JPEG, NO proof_copy   → should appear in the dry-run plan
--   rec-2  JPEG, HAS proof_copy  → idempotency skip (NOT in plan)
--   rec-3  PDF,  NO proof_copy   → should appear in the dry-run plan

INSERT INTO receipt_records
  (id, captured_at, captured_by, original_r2_key, original_sha256,
   original_content_type, original_size_bytes, status, merchant, currency,
   created_at, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', '2026-06-01T00:00:00Z', 'seed',
   'receipts/2026/06/rec-1/seed-img1.jpg',
   'aaaa0000', 'image/jpeg', 700000, 'reviewed', 'Seed JPEG Merchant', 'JPY',
   '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'),
  ('22222222-2222-4222-8222-222222222222', '2026-06-02T00:00:00Z', 'seed',
   'receipts/2026/06/rec-2/seed-img2.jpg',
   'bbbb0000', 'image/jpeg', 650000, 'reviewed', 'Seed JPEG Already-Proof', 'JPY',
   '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z'),
  ('33333333-3333-4333-8333-333333333333', '2026-06-03T00:00:00Z', 'seed',
   'receipts/2026/06/rec-3/seed-pdf.pdf',
   'cccc0000', 'application/pdf', 120000, 'reviewed', 'Seed PDF Merchant', 'JPY',
   '2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z');

-- rec-2 already has a proof_copy → the idempotent dry-run must skip it.
INSERT INTO receipt_files
  (id, object_type, object_id, role, r2_bucket, r2_key, original_filename,
   content_type, file_size_bytes, sha256_hash, uploaded_by, uploaded_at,
   created_at, updated_at)
VALUES
  ('rf-seed-2', 'receipt', '22222222-2222-4222-8222-222222222222', 'proof_copy',
   'receipts', 'receipts/22222222-2222-4222-8222-222222222222/proof.jpg',
   'proof.jpg', 'image/jpeg', 80000, 'bbbb0000-proof', 'seed',
   '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z');
