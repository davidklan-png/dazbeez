ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session, no live D1/R2 bindings) designed the following change and
needs it implemented, verified against live bindings, and reported back —
not redesigned. If you hit a design decision this prompt doesn't cover, stop
and report back instead of improvising.

# Unlock 2026-06 + apply review edits

## Context

2026-06's AMEX reconciliation is `finalized` (confirmed in
docs/month-close-runbook.md §"Sealing 2026-06"). No code path exists today
to reverse that — `rejectIfReceiptInFinalizedReconciliation` /
`isAmexLikeForLock` (lib/receipts/receipt-locks.ts,
lib/receipts/db.ts:2966) block every receipt edit in a finalized-reconciliation
month, and AGENTS.md backlog #7 flags that an unfinalize flow has never been
built or verified. ADR 0009 sketches a full audited "reopen" mechanism but
explicitly says it isn't implemented — that's the **export**-revision flow
(`createExportRevision`) and is a different lock (`receipt_exports`) than the
one blocking us here.

Operator decision (David, 2026-07-20): this system is still in beta, not yet
delivered to the tax accountant — no compliance/audit-trail requirement yet.
Build a **minimal, reusable unfinalize action** (not the full ADR 0009
ground/actor machinery) so this doesn't require hand-written SQL every time a
month needs reopening during beta review cycles.

## Part 1 — Minimal unfinalize action for `amex_reconciliations`

1. **`lib/receipts/db.ts`** — add `unfinalizeReconciliation`, mirroring
   `finalizeReconciliation`'s conventions (same file, ~line 3109):

   ```ts
   export async function unfinalizeReconciliation(
     statementMonth: string,
     actor: string,
     reason: string,
   ): Promise<void> {
     const db = getReceiptsDb();
     const row = await db
       .prepare(
         `SELECT id FROM amex_reconciliations WHERE statement_month = ? AND status = 'finalized' LIMIT 1`,
       )
       .bind(statementMonth)
       .first<{ id: string }>();
     if (!row) {
       throw new Error(`No finalized reconciliation found for ${statementMonth}.`);
     }
     await db
       .prepare(
         `UPDATE amex_reconciliations
          SET status = 'draft', finalized_by = NULL, finalized_at = NULL
          WHERE id = ?`,
       )
       .bind(row.id)
       .run();
     await createAuditEntry(db, {
       actor,
       action: "amex.reconciliation_amended",
       objectType: "amex_reconciliation",
       objectId: row.id,
       newValueJson: stringifyJson({ reason, statementMonth, unfinalized: true }),
     });
   }
   ```

   Note: `amex.reconciliation_amended` already exists in the `AuditAction`
   union (lib/receipts/types.ts:125) but is currently unused anywhere in the
   codebase — it was pre-declared for exactly this. Use it as-is, no type
   change needed.

   No cleanup-of-stale-draft handling needed here: `createReconciliationDraft`
   (db.ts:3061) already deletes any stale `draft` row for the month before
   inserting a fresh one, so the row this function leaves behind is harmlessly
   replaced whenever the operator re-runs the normal finalize flow later.

2. **New route** `app/api/receipts/reconcile/unfinalize/route.ts` — mirror
   `app/api/receipts/reconcile/finalize/route.ts`'s shape: `requireReceiptsActor`
   for auth, `POST` body `{ month: string; reason: string }`, validate
   `month` matches `/^\d{4}-\d{2}$/` and `reason` is a non-empty string, call
   `unfinalizeReconciliation(month, actor, reason)`, return `{ ok: true,
   month }` on success. 404/400 on "no finalized reconciliation found", 401
   on unauthorized, matching the finalize route's error-handling pattern.

3. **Tests** — add `tests/receipts/reconciliation-unfinalize.test.ts` (or
   extend an existing reconciliation test file): finalized → unfinalize →
   status is `draft`, `finalized_by`/`finalized_at` cleared, audit entry
   written with the right action/objectId; unfinalize on a non-finalized
   month throws/404s.

4. `npm test` and `tsc --noEmit` must be clean before moving on.

## Part 2 — Add BusinessPurpose to the AMEX + CASH/DIGITAL reconciliation CSVs

Confirmed gap: `lib/receipts/export.ts`'s machine-layer receipts CSV already
has a `BusinessPurpose` column (`EXPORT_CSV_HEADERS`), but the two
accountant-facing 照合CSVs built in `lib/receipts/reconciliation-files.ts`
(review #2, the AMEX passthrough + CASH/DIGITAL split) do not carry it at
all. David wants it added to both, written from the receipt's
`business_purpose` and left blank when null (same `csvEscape(null) → ""`
behavior already used everywhere else in this file — no special-casing
needed for "unless null").

1. **`lib/receipts/reconciliation-files.ts`**:
   - Add `"事業目的"` to `AMEX_RECONCILIATION_APPEND_HEADERS` (matches this
     file's existing Japanese-header convention — 科目＆No., 会議-出席者ID,
     人数, 領収書ファイル名). Place it right after `科目＆No.` and before
     `会議-出席者ID`, so business purpose reads next to the category label.
   - Add `businessPurpose: string` to the `AmexLineAppend` interface.
   - In `buildAmexReconciliationCsv`, emit `csvEscape(append.businessPurpose)`
     in the matching position in the appended-cells array.
   - Add `"事業目的"` to `PAYMENT_PATH_CSV_HEADERS` in the same relative
     position (after `科目＆No.`).
   - In `buildPaymentPathReconciliationCsv`, emit
     `csvEscape(row.businessPurpose ?? "")` in the matching position — `row`
     is already an `ExportRow` with `businessPurpose` on it, no new param
     needed.

2. **`app/api/receipts/export/month/route.ts`** — where `appends.set(...)` is
   built (~line 348, inside the AMEX recon loop), add
   `businessPurpose: row.businessPurpose ?? ""` to the object literal.

3. **Tests** — `tests/receipts/reconciliation-files.test.ts` almost certainly
   asserts exact header/row arrays; update the expected headers and cell
   arrays for both CSV builders. Add a case with a null `businessPurpose`
   confirming the cell renders empty, not "null"/"undefined".

4. `npm test` and `tsc --noEmit` clean.

## Part 3 — Ship Parts 1–2, then unlock 2026-06

1. Branch per AGENTS.md workflow. Commit Parts 1 and 2 (they're independent
   features — fine to land as one PR or two, your call). Push, PR, merge,
   `npm run deploy`. `bash scripts/check-deployment.sh <base-url>` smoke test.
2. On dazbeez.com, unfinalize 2026-06 via the new route (mirror the
   revision-2 runbook's curl pattern, docs/month-close-runbook.md):
   ```bash
   curl -X POST 'https://dazbeez.com/api/receipts/reconcile/unfinalize' \
     -H 'Content-Type: application/json' \
     -H 'Cookie: <clerk session>' \
     -d '{"month":"2026-06","reason":"beta review — receipt corrections before accountant delivery"}'
   ```
3. Confirm 2026-06 receipts are now editable (spot-check one PATCH against a
   June receipt succeeds where it previously 409'd).

## Part 4 — Apply David's review edits to 2026-06 receipts

David is running you on the Mac, in person — get exact values from him
directly before writing anything; do not guess merchant names, wording, or
attendee names. Use the existing `PATCH /api/receipts/[id]` (business
purpose, expense category, attendees all already supported fields — see
app/api/receipts/[id]/route.ts:123-127) and `DELETE /api/receipts/[id]`
(hardDeleteReceipt, requires actor+reason) — no new code needed for these,
just correct data and correct targeting.

a. **Business purpose on CASH IC-card-charge receipts** — find CASH-path,
   2026-06 receipts merchant `交通系ICカードチャージ`. Per
   docs/month-close-runbook.md §IC cards, this is the "business-dedicated
   card" case (business_purpose note makes the top-up directly expensable).
   List every matching receipt (date, amount) for David to confirm, then ask
   him for the exact business_purpose text — do not default to boilerplate
   without his sign-off.

b. **Delete the ¥60 cash receipt** — find the CASH, 2026-06, `amount_minor =
   60`, `currency = JPY` receipt. Confirm merchant/date with David before
   deleting (there should be exactly one match — if more than one, stop and
   ask which). Delete via `DELETE /api/receipts/[id]` with a reason
   referencing this review pass.

c. **Attendees for the May 1 and May 2 charges** — note 2026-06's AMEX
   statement window is Apr 10–May 7 (statement lag, per the runbook), so
   these are very likely AMEX-path charges dated 2026-05-01 and 2026-05-02
   sitting inside the June statement, not June-dated receipts. Find both
   (list merchant/amount for David to confirm which two he means — "May 1
   and May 2 charges" could match more than one line each), then ask him for
   the attendee names to write. If the receipt attendees are what need
   editing (not the AMEX line's own direct attendees), use the receipt PATCH
   `attendees` array; if it's the line-level attendees, say so — that's a
   different write path (`amex_line_attendees`, not covered by this prompt)
   and you should stop and report back rather than improvise which one.

d. **Expense category changes on "some receipts"** — David has specific
   receipts in mind; ask him which ones and what category codes
   (`expense_category_code`, canonical codes only — `isCanonicalCode` in the
   PATCH route validates this). Don't guess from context.

For every edit in this part, log what you changed (receipt id, field,
old→new) — the architect will verify against this list, not just trust that
tests pass.

## Part 5 — Re-seal, or leave open?

After the edits land, ask David whether he wants 2026-06's reconciliation
re-finalized now (normal flow, `POST /api/receipts/reconcile/finalize`) or
left in draft for further review. Do not re-finalize unilaterally. Separately:
2026-06's **export** already shipped a revision-2 (per the runbook's format
transition) — if these receipt edits should also flow into a corrected
export, that needs a NEW export revision (`?correction=true`, existing flow,
no new code) but that's an export-level decision distinct from the
reconciliation reopen this prompt covers. Flag it to David; don't do it
without him asking.

## Report back

- Commit SHA(s) + PR number(s), deploy + smoke-test results.
- Test results for Parts 1–2 (new tests passing, `tsc --noEmit` clean).
- Confirmation 2026-06 unfinalize succeeded (response body) and that a
  receipt PATCH which previously 409'd now succeeds.
- The full edit log from Part 4 (receipt id, field, old value → new value)
  for every change made, plus anything David asked you to hold off on.
- Whether re-finalize / export revision happened, and if not, that it's
  still pending David's call.
