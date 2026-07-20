-- 0030_category_pattern_rules.sql
--
-- Category suggestions from recognized sender/merchant patterns. The system
-- proposes a rule when ≥3 receipts from the same sender/merchant share a
-- category; the operator explicitly accepts on a Settings page; once a rule
-- exists, matching receipts/AMEX lines get a VISIBLE "Suggested: X — Accept"
-- affordance (never a silently pre-selected field — see form-pane autosave).
--
-- PRINCIPLE (load-bearing): nothing here ever writes expense_category_code
-- automatically. A rule only ever produces a suggestion; a human click (same
-- PATCH path as a manual category pick) is what sets the code. Until then the
-- receipt stays a missing_category blocker. (lib/receipts/extraction.ts:326,448
-- sets expenseCategoryCode: null at capture; compliance.ts:79 blocks on null.)
--
-- match_value encoding:
--   sender  = the sender email lowercased. Contains '@' → exact-address rule;
--             no '@' → domain rule (matches any address at that domain).
--   merchant = canonicalizeMerchant(merchant) (lib/receipts/merchant.ts:128) —
--             the 4 known konbini chains collapse to a canonical token, every
--             other merchant passes through verbatim.
CREATE TABLE IF NOT EXISTS merchant_category_rules (
  id TEXT PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('sender', 'merchant')),
  match_value TEXT NOT NULL,
  expense_category_code TEXT NOT NULL,
  accepted_by TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  source_receipt_ids_json TEXT
);

-- One rule per (match_type, match_value): re-accepting a proposal for the same
-- sender/merchant replaces, and a second rule for the same key can't exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_category_rules_match
  ON merchant_category_rules(match_type, match_value);

-- Proposals the operator explicitly dismissed, so the settings page doesn't
-- keep re-surfacing them. Keyed on (match, category): dismissing category Y for
-- a sender does NOT suppress a later proposal of a different dominant category
-- Z for the same sender.
CREATE TABLE IF NOT EXISTS category_rule_dismissals (
  match_type TEXT NOT NULL CHECK (match_type IN ('sender', 'merchant')),
  match_value TEXT NOT NULL,
  expense_category_code TEXT NOT NULL,
  dismissed_by TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (match_type, match_value, expense_category_code)
);
