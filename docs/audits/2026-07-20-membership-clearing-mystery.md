# Architect handoff — export_statement_month silently reverting to NULL

**From:** Mac worker session (Claude Code CLI), 2026-07-20
**Operator report:** "These Cash receipts from July should auto-assign to July" —
July-dated CASH receipts are showing up unassigned (NULL `export_statement_month`)
instead of in their calendar month (2026-07), violating the ADR 0008 calendar
rule. This is the same membership-reliability theme David has hit repeatedly.
**Request:** root-cause why `export_statement_month` reverts to NULL despite no
audited clearing path, and spec a fix. The worker has hit the limit of what
code-reading + the audit trail explain; this needs the architect.

---

## CONFIRMED ROOT CAUSE (architect, 2026-07-20) + hotfix

**Root cause: the receipt PATCH route passed omitted optional fields as
undefined-valued own properties.** `app/api/receipts/[id]/route.ts` built the
update object with `exportStatementMonth` (and every other optional field)
defaulting to `undefined`. JS's `in` operator reports an undefined-valued own
property as present, so `updateReceiptRecord`'s `"exportStatementMonth" in input`
check was TRUE and it bound `input.exportStatementMonth ?? null` → NULL —
clearing the column on every PATCH, including attendees-only. The membership
hook's `explicitOverrideInInput` was likewise TRUE (the key existed), so automatic
assignment was suppressed.

**Why the audit hid it:** `JSON.stringify` OMITS undefined-valued properties, so
the generic `receipt.updated` audit showed no `exportStatementMonth` even though
the SQL cleared it. The earlier "no audited clearing path" finding was correct
about the *audit* — it genuinely didn't show the field — but the clearing was
happening via the SQL bind, invisible to the audit.

**Broader blast radius:** every optional receipt field whose update logic
combined a `"field" in input` presence check with a `?? null` bind —
exportStatementMonth, transactionDate, merchant, amountMinor, taxAmountMinor,
businessPurpose, processedR2Key, extractionJson, exportedMonth,
expenseCategoryCode, sourceType, invoiceRegistrationNumber, counterpartyName,
taxRate, qualifiedInvoiceStatus, extractionEnqueuedAt/ProcessedAt/Processor.
Any of these could be silently NULLed by an ordinary form PATCH that omitted it.
The 5 July CASH receipts are the visible symptom; other optional fields on
receipts touched by prior sparse PATCHes may have been cleared too (see the
read-only audit below).

**Earlier hypotheses RULED OUT:** the non-app writer (MLX consumer / scheduled
worker / scripts) and the empty-SET UPDATE were NOT the cause. The empty-set
guard (`if (sets.length === 0) return`, db.ts) never triggered for these PATCHes
because the undefined-valued fields ADDED entries to `sets` via the `in` checks —
so the guard saw a non-empty update and ran the clearing UPDATE.

**Hotfix (branch `hotfix/receipt-patch-undefined-clearing`):**
1. `compactUndefinedReceiptUpdate` (lib/receipts/receipt-update.ts) drops
   undefined-valued own properties before `updateReceiptRecord`; the same sparse
   object drives the SQL mutation and the generic audit.
2. `updateReceiptRecord` presence checks switched from `"field" in input` to
   `input.field !== undefined` for every optional field (defense in depth,
   extracted into a pure, unit-tested `buildReceiptUpdateSets`). The empty-set
   guard now genuinely no-ops attendees-only PATCHes (no UPDATE, no generic
   audit; the attendee mutation's own audit is authoritative).
3. Override API: `exportStatementMonth` is rejected when null/empty/invalid/not
   an open concrete YYYY-MM (no unassignment — stored membership is the sticky
   authority). Concrete open months remain supported.
4. `assignMembershipForReceipt` writes the assignment audit only when the
   conditional UPDATE actually changes a row (no false audits on a lost race /
   already-assigned row).

The sections below are the original (pre-confirmation) handoff analysis, kept for
the reproducer + evidence trail.

---

## Symptom + evidence

5 of 7 July-dated CASH receipts have `export_statement_month = NULL` (2 are
correctly `2026-07`). The 5 NULL ones:

| receipt (prefix) | date | source | captured | updated (today) | stmt_month |
|---|---|---|---|---|---|
| `a92e47fa` | 2026-07-01 | mobile_capture | 07-01 | **13:32** | NULL |
| `b107efb2` | 2026-07-01 | mobile_capture | 07-19 | 11:54 | NULL |
| `48e16454` | 2026-07-05 | mobile_capture | 07-19 | 11:54 | NULL |
| `5535d1a3` | 2026-07-11 | mobile_capture | 07-19 | (NULL) | NULL |
| `1239c951` | 2026-07-14 | mobile_capture | 07-19 | 13:02 | NULL |

(The 2 correctly-assigned: `6374a255` desktop_upload 07-19, `aff37cf9`
mobile_capture 07-20 — both `2026-07`.)

**They WERE assigned, then reverted:**
- A one-time backfill (worker, 07:04 UTC) set all 7 → `2026-07` (verified:
  `stmt_month='2026-07': 7`).
- The audit shows `b107efb2` and `a92e47fa` were **assigned** to `2026-07`
  **twice** — once by the backfill (07:04, `receipt.export_statement_month_assigned`,
  reason `natural`) and again by the broadened `updateReceiptRecord` hook
  (10:56, post PR #143 deploy) — yet both are NULL now with `updated_at` later
  than the assignment (11:54, 13:32).

## The contradiction (why I'm escalating)

`export_statement_month` has **three** write paths, all audited:
1. `assignMembershipForReceipt` (membership.ts:187) — `SET export_statement_month
   = ? WHERE id = ? AND export_statement_month IS NULL` → only SETS (never
   clears), only when NULL, audited `receipt.export_statement_month_assigned`.
2. `updateReceiptRecord` (db.ts:276) — `SET export_statement_month = ?` only when
   `"exportStatementMonth" in input`; audited via the generic `receipt.updated`
   (input logged) + a dedicated `receipt.export_statement_month_overridden` when
   it's an override.
3. (db.ts:2558 is a **read** — `month: r.export_statement_month ??
   r.transaction_date.slice(0,7)` — a display fallback in one list function; not
   a write. Worth noting: this IS a read-side COALESCE, contrary to the
   "single stored authority" stance.)

**Definitive checks on `a92e47fa` (the 13:32 update):**
- Its 4 `receipt.updated` entries today (13:32:51/56 × 2) have inputs
  `['paymentPath','transactionDate','merchant','amountMinor','currency',
  'businessPurpose','expenseCategoryCode','status']` and `['attendees']` —
  **none contain `exportStatementMonth`**. So `updateReceiptRecord`'s
  db.ts:276 branch does not fire; per the code it must not touch the column.
- **No** `receipt.export_statement_month_overridden` audit to null on any of the
  5 (the one override audit found SET `2026-07`).
- The form-pane PATCH bodies (form-pane.tsx:245 and :371) were read directly and
  do **not** include `exportStatementMonth` (only the override control at :312
  sends it, on explicit reassignment).

**So: no audited app path clears `export_statement_month`, the relevant PATCHes
don't carry the field, the hook only sets — yet the column is NULL with a fresh
`updated_at`.** The app code, as read, cannot produce this state.

## Hypotheses for the architect (not exhausted)

1. **A non-app write path** is clearing it — the most likely. Candidates the
   worker could not rule out from code alone:
   - The Mac MLX consumer (scripts/receipts-consumer/) writing
     `receipt_records` directly (re-extraction / re-render POSTs, or a direct
     D1 write) that omits/zeroes `export_statement_month`.
   - A scheduled Worker or the receipts-auto-promote-render plist
     (scripts/receipts-consumer/com.dazbeez.receipts-auto-promote-render.plist).
   - A migration re-run or a `scripts/migrate-membership-to-calendar-month.ts`
     re-execution.
   - The iOS capture client (DazbeezCapture) PATCHing with a body the route
     funnels through a path that clears it.
2. **A subtle app bug**: e.g., an attendees-only PATCH
   (`input = { attendees }`) reaching `updateReceiptRecord` produces an
   empty `sets` array → a malformed/empty `UPDATE receipt_records SET …`
   (`db.ts:313`) — verify whether that no-ops, errors, or somehow nulls columns.
   (The audit shows `attendees`-only `receipt.updated` entries, so this input
   shape does reach `updateReceiptRecord`.)
3. **Concurrency / stale `before`**: two overlapping PATCHes where the
   `before.export_statement_month` snapshot used by the hook is stale.

## Reproducer for the architect

The clearest live signal: `a92e47fa` was assigned `2026-07` at 10:56 (hook) and
is NULL at 13:32 after attendees/form PATCHes that do not carry
`exportStatementMonth`. Re-assigning it (worker can) and watching whether/when it
reverts — with `wrangler tail` + the audit log — should catch the clearer in the
act. All 5 are currently NULL and available as targets.

## What I need from the architect

- Root-cause the clearing (trace the non-app write paths — MLX consumer,
  scheduled workers, scripts — and/or the empty-SET UPDATE / attendees-only
  input path) and confirm the mechanism.
- A fix spec. Note David's standing constraint: he rejected read-time COALESCE
  (breaks roll-forward, masks the bug) and wants a single sticky stored
  authority — so the fix should make the stored column reliable, not paper over
  it. (The db.ts:2558 read-fallback should probably also be reconciled with that
  stance.)

## Worker stopgap (available, not applied)

Re-assigning the 5 to `2026-07` (D1 UPDATE + `receipt.export_statement_month_assigned`
audit, as before) puts them in July immediately — but if the clearer is still
active they will revert. Held off pending the architect's root cause so the
NULL state stays inspectable; can apply on David's word.
