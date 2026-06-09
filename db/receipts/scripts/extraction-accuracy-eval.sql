-- Extraction accuracy evaluation (baseline pipeline vs human-confirmed truth)
-- ---------------------------------------------------------------------------
-- Ground truth = reviewer-confirmed columns on receipt_records (only receipts a
-- human has verified: status in reviewed/reconciled/exported/archived).
-- Prediction = the extraction_json saved at capture, BEFORE any human edit.
-- This is the canonical definition behind the live "is an SLM necessary?"
-- dashboard. Run against RECEIPTS_DB.
--
-- Match rules:
--   amount   : numeric equality (amountMinor == amount_minor)
--   date     : exact YYYY-MM-DD string equality
--   currency : case-insensitive equality
--   merchant : case-insensitive, trimmed exact equality (harsh on purpose —
--              "did the machine produce the value the reviewer kept?")
--   expense  : enum equality, ONLY where truth is set (<> 'UNKNOWN'); otherwise
--              there is no label to score against.
--
-- A field's denominator counts only rows where truth is present, so empty==empty
-- never inflates accuracy.

-- ── 1. Per-receipt comparison (the dashboard fetches this and aggregates) ─────
SELECT
  substr(r.transaction_date, 1, 7)                         AS ym,
  r.transaction_date                                       AS t_date,
  json_extract(r.extraction_json, '$.transactionDate')     AS p_date,
  r.merchant                                               AS t_merchant,
  json_extract(r.extraction_json, '$.merchant')            AS p_merchant,
  r.amount_minor                                           AS t_amount,
  json_extract(r.extraction_json, '$.amountMinor')         AS p_amount,
  r.currency                                               AS t_curr,
  json_extract(r.extraction_json, '$.currency')            AS p_curr,
  r.expense_type                                           AS t_exp,
  json_extract(r.extraction_json, '$.expenseType')         AS p_exp,
  json_extract(r.extraction_json, '$.provider')            AS provider
FROM receipt_records r
WHERE r.extraction_json IS NOT NULL
  AND r.status IN ('reviewed','reconciled','exported','archived')
  AND r.legacy = 0
  AND r.transaction_date IS NOT NULL
ORDER BY r.transaction_date;

-- ── 2. Per-month rollup (same logic, aggregated server-side) ─────────────────
-- Each *_acc is a 0..1 ratio over rows where that field's truth is present;
-- NULL means no labeled rows for that field that month (not 0%).
SELECT
  substr(r.transaction_date, 1, 7) AS ym,
  COUNT(*)                          AS n,

  CAST(SUM(CASE WHEN json_extract(r.extraction_json,'$.amountMinor') = r.amount_minor THEN 1 ELSE 0 END) AS REAL)
    / NULLIF(SUM(CASE WHEN r.amount_minor IS NOT NULL THEN 1 ELSE 0 END), 0)            AS amount_acc,

  CAST(SUM(CASE WHEN json_extract(r.extraction_json,'$.transactionDate') = r.transaction_date THEN 1 ELSE 0 END) AS REAL)
    / NULLIF(SUM(CASE WHEN r.transaction_date IS NOT NULL THEN 1 ELSE 0 END), 0)        AS date_acc,

  CAST(SUM(CASE WHEN lower(trim(json_extract(r.extraction_json,'$.merchant'))) = lower(trim(r.merchant)) THEN 1 ELSE 0 END) AS REAL)
    / NULLIF(SUM(CASE WHEN r.merchant IS NOT NULL AND trim(r.merchant) <> '' THEN 1 ELSE 0 END), 0) AS merchant_acc,

  CAST(SUM(CASE WHEN upper(json_extract(r.extraction_json,'$.currency')) = upper(r.currency) THEN 1 ELSE 0 END) AS REAL)
    / NULLIF(SUM(CASE WHEN r.currency IS NOT NULL THEN 1 ELSE 0 END), 0)                AS currency_acc,

  CAST(SUM(CASE WHEN r.expense_type <> 'UNKNOWN'
                 AND json_extract(r.extraction_json,'$.expenseType') = r.expense_type THEN 1 ELSE 0 END) AS REAL)
    / NULLIF(SUM(CASE WHEN r.expense_type <> 'UNKNOWN' THEN 1 ELSE 0 END), 0)           AS expense_acc
FROM receipt_records r
WHERE r.extraction_json IS NOT NULL
  AND r.status IN ('reviewed','reconciled','exported','archived')
  AND r.legacy = 0
  AND r.transaction_date IS NOT NULL
GROUP BY ym
ORDER BY ym;
