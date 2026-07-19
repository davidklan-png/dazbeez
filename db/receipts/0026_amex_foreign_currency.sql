-- 0026_amex_foreign_currency.sql
--
-- Foreign-currency detail for overseas-billed AMEX charges
-- (Cloudflare / Anthropic / etc.). The Netアンサー statement reports only the
-- JPY-converted total in amount_minor and the charge row's memo carries the
-- original foreign amount as free text (現地通貨額:<amt> <CCY>); the row
-- immediately after carries the FX rate used (円換算レート:M/D <rate>).
-- reconciliation.ts previously hard-gated on line.currency === receipt.currency,
-- so a USD receipt (receipt_records.currency = 'USD') was never even considered
-- against a JPY statement line — a total exclusion, not a tolerance bug.
--
-- These columns let reconciliation match a USD/EUR/... receipt against the
-- line's foreign amount instead of the JPY total. All four are nullable, no
-- default, no backfill-at-migration-time: existing rows stay NULL (behave
-- exactly as today — ordinary domestic-JPY matching) and the open-month
-- backfill script (scripts/backfill-amex-foreign-currency.ts) populates them
-- for already-imported lines. Finalized months are never touched (immutable
-- per the existing guard).
--
--   foreign_amount_minor       — parsed foreign amount in minor units (cents
--                                for non-JPY). Sign inherits from amount_minor
--                                (a refund line's foreign amount is negative).
--   foreign_currency           — ISO code, e.g. 'USD' (uppercase).
--   foreign_exchange_rate      — the 円換算レート parsed off the trailing
--                                continuation row. INFORMATIONAL / AUDIT ONLY:
--                                never authoritative, never used to convert
--                                anything. Matching compares
--                                foreign_amount_minor directly. Stored purely
--                                so the cross-check (rate × foreign amount ≈
--                                JPY total) can catch a bad parse.
--   memo_currency_parse_status — NULL = no foreign marker on the memo at all
--                                (ordinary JPY line, behaves identically to
--                                today); 'parsed' = extracted cleanly;
--                                'unparsed' = marker present but extraction
--                                failed (or the rate cross-check failed) —
--                                surfaces an amber pill in the reconcile UI so
--                                it is not silently lost into "unmatched".
ALTER TABLE amex_statement_lines ADD COLUMN foreign_amount_minor INTEGER;
ALTER TABLE amex_statement_lines ADD COLUMN foreign_currency TEXT;
ALTER TABLE amex_statement_lines ADD COLUMN foreign_exchange_rate REAL;
ALTER TABLE amex_statement_lines ADD COLUMN memo_currency_parse_status TEXT
  CHECK (memo_currency_parse_status IS NULL
         OR memo_currency_parse_status IN ('parsed', 'unparsed'));
