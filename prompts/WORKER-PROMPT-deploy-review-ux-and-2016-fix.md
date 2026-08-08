ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT verified your
review-queue-UX implementation (550 tests re-run independently, code review
clean) and the operator approved deploy. This prompt covers two things:
the 2016-03 date-anomaly fix, then deploy. If anything below turns out
ambiguous, stop and report instead of improvising.

# A. Fix the 2016-03 date anomaly (2 receipts)

## A0. Investigate FIRST (read-only, include full output in report)

```sql
SELECT id, merchant, amount_minor, currency, transaction_date, captured_at,
       status, payment_path, source_type, export_statement_month,
       substr(extraction_json, 1, 400) AS extraction_head
FROM receipt_records
WHERE deleted_at IS NULL AND transaction_date LIKE '2016-%';
```

Also pull any audit entries for those two ids.

## A1. Decision rule (do not deviate)

- If `captured_at` is in 2026 AND the extraction/receipt content is
  consistent with a 2026 date (typical OCR decade slip), correct the year
  ONLY: `2016-MM-DD` → `2026-MM-DD`, same month/day.
- If either receipt's evidence is NOT clearly a year typo (e.g.
  captured_at is also old, or extraction genuinely reads 2016), STOP for
  that receipt and report — do not guess.

## A2. Apply (audited, through the app's own logic where possible)

- Preferred: a small one-off script (tsx, live bindings — same pattern as
  existing scripts/) that calls `updateReceiptRecord(id, { transactionDate })`
  so the existing audit entry + membership assignment
  (`assignMembershipForReceipt`, calendar rule ADR 0008) run exactly as a
  UI edit would. Do NOT hand-write UPDATE statements unless the app path
  is impossible; if you must, replicate the audit entry
  (`createAuditEntry`) and membership assignment yourself and say so.
- Note the export gate: 2026-03 has NO export row, so
  `assertTransactionMonthEditable` will pass. If the corrected date lands
  anywhere else, re-check against sealed months first.
- After the fix, re-run A0's query (expect zero rows) and report each
  receipt's new `transaction_date` and `export_statement_month`.
- FLAG in the report (operator decision, not yours): these two receipts
  will now sit in 2026-03, a month that never had an export built. They
  need either a 2026-03 export or a membership override to an open month.
  Do not do either.

# B. Deploy

1. Full test suite green (`npm test`) and `npm run build:cf` clean.
2. `npm run deploy` (standard workflow).
3. Post-deploy sanity from your side (unauthenticated is fine): the
   worker responds, `/` is 200, no deploy errors in wrangler output.
4. The 6 behavioral checks (7.1–7.6 of prompts/WORKER-PROMPT-review-queue-ux.md)
   are run by the operator/architect in a browser on prod — not you.
   List them at the end of your report as a ready-to-tick checklist,
   with the concrete URLs filled in (sealed month = 2026-06).

# Report back

A0 output, per-receipt decision + action taken, post-fix verification
rows, test/build/deploy results, and the filled-in prod checklist.
