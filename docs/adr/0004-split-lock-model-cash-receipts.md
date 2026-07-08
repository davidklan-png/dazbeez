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
- `assertTransactionMonthEditable(month)` — throws when the month is locked for edits (see predicate below). No-op for null/empty input, since uploads insert with a null `transaction_date` and the lock can't apply until the extraction backfill lands.
- `isMonthLockedForEdits(db, month)` — the actual edit-lock predicate. Returns true iff an export exists at `status='finalized'` for the month AND no export exists at `status='draft'` for the month. Implemented as a single D1 CASE expression; one indexed lookup per mutation.
- `transactionMonthOf(date)` — derives `YYYY-MM` from a YYYY-MM-DD or ISO timestamp.

### Draft revision reopens the month (correction-flow fix, 2026-07-08)

Finalized export rows are permanent (preservation principle — `receipt_exports.status='finalized'` never transitions back). Without a carve-out, the correction flow could never actually correct anything: `POST /api/receipts/export/<month>?correction=true` creates a fresh `status='draft'` revision row, but the finalized row it sits next to would keep the lock engaged and every edit attempt would re-throw.

The predicate resolves this by treating "has open draft revision" as a release of the lock. While the draft exists, edits land normally against the live `receipt_records` rows. Finalizing the revision consumes the draft (it becomes the new finalized row), so the lock re-closes automatically — no explicit "re-seal" step is needed.

This is why the predicate is **not** memoized: the locked state is no longer monotonic. A module-level `Set<string>` cached "locked" would survive a revision draft being opened within the same Worker isolate, and the correction flow would deadlock again. One D1 lookup per mutation is the correct cost; the index on `receipt_exports(export_month, status)` makes it cheap.

Wired into:
- `createReceiptRecord` (no-op for the upload path, which inserts at status='captured' with null date; guards callers that supply the date up front)
- `updateReceiptRecord` (checks the **effective** transaction month — input override wins, else the existing row's date)
- Routes catch `ExportFinalizedError` → 409 with a message naming the revision endpoint: `POST /api/receipts/export/<month>?correction=true`.

## Consequences

- A late cash receipt for a finalized month must go through `createExportRevision` (the `?correction=true` endpoint). Direct inserts/edits return 409 — **until** the revision draft exists, at which point the month reopens for the duration of the correction. Finalizing the revision re-seals the month.
- Receipt rows already at `status='exported'` (set by `finalizeExport`) surface a revision hint in their 409 too — the operator knows exactly where to go.
- The reconciliation-sealed gate is unchanged for AMEX paths; existing edit-rejection behavior there is preserved.
- The locks compose cleanly when both are active (a month can be both reconciliation-sealed and export-finalized — they protect different populations).
- The lock state is non-monotonic (open draft → released; finalize draft → re-locked). It must be re-computed per mutation from D1 — never cached in-process.
