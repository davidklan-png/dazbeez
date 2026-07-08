# ADR 0002 — Export scope: the statement month, not the transaction-date month

- **Status:** Accepted
- **Date:** 2026-07-08
- **Owner:** David (PM)
- **Affects:** `lib/receipts/month-closing.ts`, `lib/receipts/export.ts`, `app/api/receipts/export/*`, `db/receipts/0017_export_integrity.sql`
- **Supersedes:** implicit transaction-date-month scope in the pre-2026-07-08 export route

## Context

The pre-redesign export CSV filtered receipts by `transaction_date LIKE 'YYYY-MM%'`. AMEX statement lines, however, post over a ~6-week window that lags the statement label (see `lib/receipts/statement-window.ts`): a late-March dinner receipt can land on the April statement, and the same receipt's `transaction_date` (March) and `statement_month` (April) disagree. Filtering the CSV by transaction-date month produced one population; the AMEX validation set (`amex_statement_lines.statement_month`) was another. The bundle was not self-consistent — the accountant reconciled against a statement population while the CSV shipped a transaction-date population, and missing-receipt lines were silently absent because they had no receipt row to filter in.

## Decision

The export unit is the **statement month**. A monthly bundle for month M contains:

1. One row per AMEX statement line of month M (`RowType=amex_line`), with the matched receipt's fields joined when present. Missing-receipt and no-receipt lines **must** appear in the CSV with their reasons — previously silently absent.
2. One row per CASH/DIGITAL receipt with `transaction_date` in month M (`RowType=receipt`). Transaction date is the accounting anchor for these — they have no statement.
3. A receipt matched to a line appears once (on the line row), never twice.
4. `payment_path = 'UNKNOWN'` is excluded; finalize blocks while any UNKNOWN receipt with `transaction_date` in M exists (its export month is ambiguous).

Row assembly lives in **one place**: `buildExportBundle(month)` in `lib/receipts/month-closing.ts`. The export route and the finalize validator consume the same rows, so the operator's preview is bit-identical to what ships. Per-item audit trail lands in `receipt_export_items` (migration 0017) so "did receipt X ever ship?" is a D1 query, not an R2 fetch.

## Consequences

- A receipt with `transaction_date` in March but matched to an April statement line ships in **April** (statement-month scope wins for matched receipts).
- The validator's UNKNOWN gate is mandatory — without it, an ambiguous receipt would have no export month and could silently slip through.
- Cross-month match integrity becomes a real concern (see ADR 0005): a receipt matched to lines in two statement months is ambiguous and blocks both.
