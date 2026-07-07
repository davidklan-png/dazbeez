# ADR 0004 — Split lock model: reconciliation-sealed vs. export-finalized

- **Status:** Accepted
- **Date:** 2026-07-08
- **Owner:** David (PM)
- **Affects:** `lib/receipts/month-lock.ts`, `lib/receipts/db.ts`, `app/api/receipts/*`, `app/api/mobile/receipts/upload/route.ts`
- **Audits:** 2026-07-08 export review (activity A5)

## Context

Before this ADR, the only "month is locked" signal derived from `amex_reconciliations.status='finalized'`. The lock was enforced narrowly: `rejectIfReceiptInFinalizedReconciliation` blocked edits only to receipts matched to an AMEX line in a finalized month. Two gaps:

1. **CASH/DIGITAL receipts had no lock at all.** A cash receipt with `transaction_date` in a month whose export had already shipped could be edited freely — even though the shipped CSV claimed an immutable SHA-256. Editing the row made the manifest hash stale and silently broke the audit chain.
2. **The lock confused two different concepts.** Sealing an AMEX reconciliation is about statement-line immutability; finalizing an export is about "this bundle shipped and the accountant has it." Conflating them meant exporting a month did not actually lock the receipts inside it.

The operator pain point: a late cash receipt for a finalized month had no defined handling path. Operators either left it for the next month (wrong — `transaction_date` is the accounting anchor) or edited the finalized month directly (wrong — broke the manifest hash).

## Decision

**Two independent locks, each blocking a different population:**

| Lock | Scope | Population blocked | Authority |
|------|-------|--------------------|-----------|
| Reconciliation-sealed | Statement month | AMEX line edits + edits to receipts matched to a line | `rejectIfReceiptInFinalizedReconciliation` in db.ts |
| Export-finalized | Transaction month | CASH/DIGITAL receipt inserts/edits where `transaction_date` falls in the finalized month | `assertTransactionMonthEditable` in month-lock.ts |

The two never overlap. AMEX-path receipts are governed by reconciliation-sealed via their statement line. CASH/DIGITAL receipts are governed by export-finalized via their `transaction_date`. A receipt never hits both locks.

The export-finalized lock is implemented by:

- `ExportFinalizedError` — typed error class so routes use `instanceof` instead of brittle substring matching on `error.message`.
- `assertTransactionMonthEditable(month)` — throws when the month has `receipt_exports.status='finalized'`. Memoized in-process for tight loops.
- `transactionMonthOf(date)` — derives `YYYY-MM` from a YYYY-MM-DD or ISO timestamp.

Wired into:
- `createReceiptRecord` (no-op for the upload path, which inserts at status='captured' with null date; guards callers that supply the date up front)
- `updateReceiptRecord` (checks the **effective** transaction month — input override wins, else the existing row's date)
- Routes catch `ExportFinalizedError` → 409 with a message naming the revision endpoint: `POST /api/receipts/export/<month>?correction=true`.

## Consequences

- A late cash receipt for a finalized month must go through `createExportRevision` (the `?correction=true` endpoint). Direct inserts/edits return 409.
- Receipt rows already at `status='exported'` (set by `finalizeExport`) surface a revision hint in their 409 too — the operator knows exactly where to go.
- The reconciliation-sealed gate is unchanged for AMEX paths; existing edit-rejection behavior there is preserved.
- The locks compose cleanly when both are active (a month can be both reconciliation-sealed and export-finalized — they protect different populations).
