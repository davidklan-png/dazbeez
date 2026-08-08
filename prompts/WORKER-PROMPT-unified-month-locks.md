ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session, no live D1/R2 bindings) designed the following change and
needs it implemented, verified against live bindings, and reported back —
not redesigned. If you hit a design decision this prompt doesn't cover, stop
and report back instead of improvising.

# Unified draft carve-out for the month locks + Part-4 edits

## Context

Your handoff (docs/audits/2026-07-20-monthly-seal-lock-system.md) was
reviewed and verified by the architect. Operator decisions (David,
2026-07-20, all three confirmed explicitly):

1. **Gate #3 gets the F1 draft carve-out** — `status='exported'` blocks
   PATCH/DELETE only when the receipt's `exported_month` has NO open draft
   revision. No status reverting (`createExportRevision` stays
   receipt-untouched; abandoning a draft auto-relocks).
2. **Deletes stay soft** — extend `softDeleteReceipt` to allow `'exported'`
   receipts under the same carve-out. `hardDeleteReceipt` stays routeless.
   Sealed revision manifests reference R2 originals by hash/key; those
   objects must survive.
3. **Reconciliation lock becomes draft-aware — for RECEIPT edits only.**
   `rejectIfReceiptInFinalizedReconciliation` releases when the finalized
   reconciliation's statement month has an open export draft. The
   LINE-level seal (`rejectIfFinalized` on `amex_statement_lines` writes)
   stays strict — a format-only export revision must NOT reopen match
   assignments. This scoping is an architect mitigation David accepted;
   do not widen it.

Net effect on 2026-06: the rev3 draft (open since 07-18) releases ALL
three gates for receipt edits the moment this deploys. **No unfinalize call
is needed** — the reconciliation stays `finalized`, and
`unfinalizeReconciliation` (PR #139) remains the lever for the day match
assignments themselves need reopening.

## Part 1 — the unified predicate

Single decision authority: a month M is "open for correction" iff
`receipt_exports` has a row at `status='draft'` for M — exactly
`isMonthLockedForEdits` (month-lock.ts) returning false while a finalized
export exists. Reuse that function everywhere below; do NOT write a new
SQL predicate. (`loadSealedExportMonths` in membership.ts is already the
set-form of the same rule — noted so you keep them consistent, not so you
add a third.)

## Part 2 — gate #3 carve-out (PATCH + DELETE)

1. **`app/api/receipts/[id]/route.ts` PATCH (~L98):** replace the hard
   `status === "exported"` 409 with: still 409 for `'archived'`
   (terminal, unchanged); for `'exported'`, 409 only when
   `receipt.exported_month` is null OR
   `await isMonthLockedForEdits(db, receipt.exported_month)` is true.
   When the carve-out releases, fall through to the normal PATCH path —
   the downstream locks in `updateReceiptRecord` still run (see Part 3).
   Update the 409 message: the revision hint is now truthful; keep it.
2. **`softDeleteReceipt` (db.ts ~L551):** allow `'exported'` when
   `exported_month` is non-null AND not locked (same predicate). Require a
   non-empty `reason` for the exported case (the route already passes one
   through; make it mandatory in this branch). `'archived'` and other
   non-deletable statuses unchanged.
3. Audit entries unchanged in shape — `receipt.deleted` /
   `receipt.updated` already fire; no new audit actions.

## Part 3 — reconciliation lock, receipt-scope carve-out

`rejectIfReceiptInFinalizedReconciliation` (db.ts ~L348): after finding a
finalized-reconciliation match, release (return without throwing) iff the
matched statement month is not locked per `isMonthLockedForEdits`. Line
paths that call `rejectIfFinalized(db, month)` on `amex_statement_lines`
writes: UNTOUCHED — verify you haven't changed line-write behavior with a
targeted test.

## Part 4 — UI lock surface must match the server

`lib/receipts/receipt-locks.ts`: the queue must not under- or over-report
409s (module header's own rule).

- EXPORT side already uses `loadSealedExportMonths` (draft-aware) — no
  change.
- RECONCILIATION side (`loadReconciliationLockedReceiptIds`): exclude
  months whose export has an open draft — add
  `AND NOT EXISTS (SELECT 1 FROM receipt_exports re
   WHERE re.export_month = ar.statement_month AND re.status = 'draft')`
  to the join, mirroring the server release.
- Check `queue-rail.tsx` / `form-pane.tsx` lock copy still reads correctly
  ("Sealed — … Reopen it to edit" may need "or open a correction draft"
  phrasing; small copy fix, your judgment).

## Part 5 — docs

1. Update the `receipt-locks.ts` header (L1–23) to describe the THREE-gate
   model with the unified draft carve-out and the line-seal exception.
2. Update the split-lock comment block in `month-lock.ts` (~L49–77)
   likewise.
3. New `docs/adr/0012-unified-draft-carveout-month-locks.md` — short:
   context (the 2026-07-20 handoff findings), the three operator decisions
   above, the receipt-vs-line scoping mitigation, consequences (an open
   export draft is the single "month open for correction" signal;
   unfinalizeReconciliation reserved for match-layer reopening; ADR 0009's
   audited-grounds machinery still future work, unblocked not replaced).

## Part 6 — tests

- PATCH: exported + open draft → 200 and fields persist; exported + no
  draft → 409; archived → 409 always.
- softDeleteReceipt: exported + open draft + reason → soft-deleted, audit
  written; exported + no draft → throws; exported + no reason → throws.
- Recon lock: AMEX-matched receipt in finalized-recon month + open export
  draft → update allowed; same without draft → throws. Line write to the
  same month → still rejected (the scoping test).
- receipt-locks: recon-locked receipt shows UNLOCKED when a draft export
  exists for the statement month (extend the existing fake-D1 tests).
- `npm test` (738+ green) and `tsc --noEmit` clean; `npm run build:cf`
  exit 0.

## Part 7 — ship + apply the Part-4 edits

1. Branch, commit, PR, merge (CI auto-deploys), smoke
   `bash scripts/check-deployment.sh https://dazbeez.com`.
2. 2026-06 already has the rev3 draft open — verify the release is live:
   the step's proof is edit (a) below succeeding where it 409'd today.
3. Apply the edits, all via the normal API/UI (GUI preferred per David's
   memory note; curl acceptable where he hands you ids):
   - **(a)** `business_purpose = "交通系ICカードチャージ(Klan)"` on the 4
     CASH IC receipts from the handoff: 0802caae… (06-02), ca757eb0…
     (06-11), 113480df… (06-22), e47e27a7… (06-27).
   - **(b)** soft-delete ¥60 CASH receipt 4af7dea8… (06-22, セブン-イレブン
     東中野末広橋店), reason referencing this review pass. Confirm with
     David immediately before executing.
   - **(c)** attendees on the May-1/May-2 charges — receipt-level
     (`receipt_attendees` via the PATCH attendees array; handoff confirmed
     0 line-level attendees exist). David gives you which lines + names in
     person.
   - **(d)** category changes — David gives receipts + canonical codes in
     person.
4. After edits: **Rebuild draft** on /receipts/export?month=2026-06 so
   rev3's staged artifacts reflect the new data (verify the ¥60 receipt is
   GONE from the rebuilt CSVs and the 事業目的 column is populated on the
   4 IC rows). Do NOT finalize — David finalizes manually later (decision
   on record).

## Report back

Commit SHA + PR, deploy/smoke results, full test tally, the Part-7 edit
log (receipt id, field, old→new for every change), rebuild verification
(¥60 absent, 事業目的 present), and anything David deferred.
