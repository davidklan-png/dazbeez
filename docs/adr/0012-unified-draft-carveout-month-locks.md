# ADR 0012 — Unified draft carve-out for the month locks

- **Status:** Accepted
- **Date:** 2026-07-20 (proposed) · 2026-07-20 (accepted, operator)
- **Owner:** David (PM)
- **Supersedes:** —
- **Superseded by:** —
- **Related:** [ADR 0004](0004-split-lock-model-cash-receipts.md) (split-lock model — this extends its F1 carve-out to all three gates), [ADR 0009](0009-sealed-month-amendment-policy.md) (audited sealed-month amendment machinery — still future work; this unblocks beta correction without replacing it), `docs/audits/2026-07-20-monthly-seal-lock-system.md` (the handoff findings this responds to), `lib/receipts/month-lock.ts` (`isMonthLockedForEdits` — the single authority), `lib/receipts/receipt-locks.ts` (review-queue lock surface), `lib/receipts/db.ts` (`rejectIfReceiptInFinalizedReconciliation`, `softDeleteReceipt`)
- **Affects:** `app/api/receipts/[id]/route.ts` (PATCH gate #3 carve-out; DELETE now parses+passes a reason), `lib/receipts/db.ts` (`softDeleteReceipt` allows `exported` under carve-out + requires reason; `rejectIfReceiptInFinalizedReconciliation` releases receipt edits under carve-out), `lib/receipts/receipt-locks.ts` (`loadReconciliationLockedReceiptIds` excludes draft months), `components/receipts/review/form-pane.tsx` (lock copy), module headers in `receipt-locks.ts` + `month-lock.ts`

## Decision record (2026-07-20)

### Context

The 2026-07-20 worker handoff (`docs/audits/2026-07-20-monthly-seal-lock-system.md`)
found that the documented two-lock split model (ADR 0004: export lock for
non-AMEX receipts, reconciliation lock for AMEX, each draft-aware via the F1
carve-out) was **defeated by a third, ad-hoc per-receipt status gate**. The
PATCH handler (`app/api/receipts/[id]/route.ts`) and `softDeleteReceipt`
(`lib/receipts/db.ts`) hard-refused `status='exported'` with **no draft
carve-out**, and nothing in the codebase ever reverted a receipt off `exported`.
Net effect: once a receipt shipped in a finalized export, it was permanently
non-editable and non-deletable via any API route — even while a correction draft
was open. This blocked the entire 2026-06 beta-review edit pass and made the
revision flow's own error advice ("create a revision") self-defeating for data
edits (the flow only ever supported format/regeneration — e.g. the 2026-06 rev2
proofs/No-column transition).

### Operator decisions (David, 2026-07-20 — all three confirmed explicitly)

1. **Gate #3 gets the F1 draft carve-out.** `status='exported'` blocks
   PATCH/DELETE only when the receipt's `exported_month` has no open draft
   revision. The authority is the existing `isMonthLockedForEdits(db, month)`
   (finalized + no draft ⇒ locked). No status reverting — `createExportRevision`
   stays receipt-untouched; abandoning/deleting a draft auto-relocks.
2. **Deletes stay soft.** `softDeleteReceipt` is extended to allow `exported`
   under the same carve-out, with a **non-empty reason required** for the
   exported branch (loud-failure / audit theme). `hardDeleteReceipt` stays
   routeless — sealed revision manifests reference R2 originals by hash/key, and
   those objects must survive a soft-delete (which only sets `deleted_at`).
3. **Reconciliation lock becomes draft-aware for RECEIPT edits only.**
   `rejectIfReceiptInFinalizedReconciliation` releases when the matched
   statement month is not locked per `isMonthLockedForEdits`. The LINE-level
   seal (`rejectIfFinalized` on `amex_statement_lines` writes) stays strict — a
   format-only export revision must NOT reopen match assignments. This scoping is
   an architect mitigation David accepted; it is not to be widened.

### Mitigation: receipt-scope vs line-scope

A correction export draft reopens the month for **receipt data edits**
(business purpose, attendees, category, soft-delete) but explicitly does **not**
reopen **match assignments** — `amex_statement_lines` writes still pass through
`rejectIfFinalized`, which is untouched. Rationale: a format/regeneration
revision (proofs bundle, column layout) should never silently unlock the
statement-to-receipt match layer that the reconciliation seal protects. If match
assignments themselves need reopening, the operator uses `unfinalizeReconciliation`
(PR #139) — the reconciliation stays `finalized` otherwise.

### Consequences

- **An open export draft is the single "month open for correction" signal.**
  One mechanism, three gates released (for receipt edits). The operator no longer
  reasons about three independent locks to correct a sealed month.
- **`unfinalizeReconciliation` is reserved for the match layer.** It is no longer
  needed to make a month's receipts editable (a draft does that) — only to reopen
  statement-line match assignments.
- **`hardDeleteReceipt` remains unreachable from the API.** Soft-delete under the
  carve-out is the supported removal path for shipped receipts; the R2 originals
  are preserved by design.
- **ADR 0009's full audited-grounds amendment machinery remains future work** —
  this ADR unblocks beta correction cycles without replacing it. Nothing here
  weakens the finalized-row permanence principle (finalized exports/reconciliations
  are never mutated; only their receipts become editable while a draft exists).
- **Review-queue lock surface mirrors the server** (`receipt-locks.ts`): the
  reconciliation side excludes months with an open draft, so the queue never
  over-reports a 409 the server would no longer throw.
