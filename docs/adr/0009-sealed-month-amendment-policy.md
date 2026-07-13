# ADR 0009 — Sealed-month amendment policy

- **Status:** Proposed (design of record — **no implementation in this change**)
- **Date:** 2026-07-14
- **Owner:** David (PM)
- **Affects (future):** the export-revision flow (`createExportRevision`,
  `lib/receipts/db.ts`), `receipt_exports.export_revision` + the
  `idx_exports_month_revision` / `idx_exports_one_draft` indexes (migration 0017),
  R2 archive immutability, the finalize route. **Nothing is built in the ADR 0008
  change — this records the policy and the intended mechanics for backlog.**
- **Builds on:** [ADR 0004](./0004-split-lock-model-cash-receipts.md) (split lock),
  migration `0017_export_integrity.sql` (export-revision column + unique indexes),
  the finalized-reconciliation / export-seal guards in `month-lock.ts`.

---

## TL;DR

Closed export months stay closed. The only way to alter a shipped month is a
**recorded amendment** — a new export revision — and amendments are gated to
exactly two grounds: **(a) human error**, **(b) accountant challenge**. The
typical amendment is an **expense-category correction**. This ADR records the
policy and sketches the mechanics for a future implementation; it is logged as
backlog and is **not** implemented in the ADR 0008 change.

## Context

An export month that has shipped (`receipt_exports.status='finalized'`, no draft)
is immutable by construction: the finalize guard (`isMonthLockedForEdits`,
`month-lock.ts`) blocks receipt edits whose transaction month is sealed, and the
finalized export row + its R2 archive are permanent. Migration 0017 already
provides the revision spine — `export_revision` (monotone per month), the unique
`(export_month, export_revision)` index, and the one-draft-per-month partial
unique index — and `createExportRevision` already opens a new draft revision
superseding the prior finalized one. What is **not** codified today is *when* an
amendment is legitimate and *what* must be recorded.

## Decision (policy)

1. **Closed months stay closed.** A finalized export is the system of record; it
   is never edited in place.
2. **Exactly two reopen grounds:**
   - **(a) Human error** — a wrong value shipped (e.g. a receipt matched to the
     wrong line, a merchant/category typo, a receipt that should not have been in
     the bundle).
   - **(b) Accountant challenge** — the accountant rejects a line/category and
     requests a corrected export.
3. **Typical amendment = expense-category correction.** Most amendments will be a
   category reclassification on one or more lines/receipts; amounts and
   membership rarely change.

## Intended mechanics (sketch — not implemented)

For a future PR, the mechanics re-use the existing revision machinery:

- **Reopen requires a recorded reason + actor.** Opening a revision
  (`POST /api/receipts/export/<month>?correction=true`) already takes a
  `correction_reason`; the future work surfaces a structured **amendment ground**
  (`human_error` | `accountant_challenge`) + free-text reason + the Clerk actor,
  stored on the revision row and audited (`export.revision_created` already
  exists). The ground constrains *why* a sealed month can reopen.
- **Edits are audited.** While a draft revision is open, the finalize guard's
  draft-carve-out (`isMonthLockedForEdits`) already releases the edit lock for
  that month; the normal receipt/line audit trail records every change.
- **Re-finalize bumps `export_revision`.** `createExportRevision` already produces
  `prior.export_revision + 1`; finalizing the draft closes the lock again.
- **Prior revisions stay immutable in R2.** Every prior revision's archive +
  manifest objects are untouched (the existing preservation principle); the
  finalized row is permanent.
- **The revision-(N+1) manifest records the delta vs N.** Future work: the
  manifest written at re-finalize lists **what changed** (which receipts/lines,
  which fields, old→new) and **why** (the amendment ground + reason), so an
  auditor comparing revision N and N+1 sees the diff without diffing two CSVs.

## Consequences (when implemented)

- Amendments are always auditable and always preserve prior shipped artifacts —
  no in-place mutation of a finalized export, ever.
- The two-ground gate makes "why did this month reopen?" answerable from the data,
  which matters for tax/電子帳簿保存法 defensibility.
- No schema change is required to record the ground/reason — `correction_reason`
  (TEXT) already exists on `receipt_exports`; a future migration would only add a
  structured `amendment_ground` column if free-text proves insufficient.

## Backlog

Implementation is logged as backlog (AGENTS.md receipts backlog). Not built in
the ADR 0008 change.
