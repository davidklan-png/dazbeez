# Architect handoff — 2026-06 monthly seal & locking system review

**From:** Mac worker session (Claude Code CLI), 2026-07-20
**Task of record:** `prompts/WORKER-PROMPT-unlock-2026-06.md`
**Operator decision (David, 2026-07-20):** stop attempting Part-4 edits; escalate
for a **full review and revision plan of the monthly seal and locking system**.
Nothing below is a request to improvise — it is a snapshot + findings for the
architect to design against.

---

## TL;DR

The codebase has a **cleanly documented 2-lock split model** (export lock for
non-AMEX receipts, reconciliation lock for AMEX, both intended to be
draft-aware). It is **defeated by a third, ad-hoc per-receipt status gate** that
has no draft carve-out and is **never reverted**. Net effect: once a receipt is
`status='exported'` it is **permanently non-editable and non-deletable via any
API route**, even when the two designed locks would allow the edit (e.g. while a
correction draft is open). This blocked 100% of the Part-4 review edits and made
the revision flow's own error advice ("create a revision") self-defeating for
data edits. The reconciliation for 2026-06 was also never actually unfinalized.
Requesting a unified review + revision plan (open questions at the end).

---

## What shipped this session (LIVE on dazbeez.com via CI)

PR #139 (merge `5e0233e`, auto-deployed, CI verify+deploy+smoke green):

1. **`unfinalizeReconciliation(statementMonth, actor, reason, db?)`** — `lib/receipts/db.ts` (after `finalizeReconciliation`, ~L3160). Flips `amex_reconciliations` `status→'draft'`, nulls `finalized_by/finalized_at`, writes `amex.reconciliation_amended` audit. Optional `db` param = testability seam (default `getReceiptsDb()`, invisible to callers). **Reverses the RECONCILIATION lock only — does NOT touch the export lock or receipt status** (see gap #3).
2. **POST `/api/receipts/reconcile/unfinalize`** — mirrors the finalize route (`requireReceiptsActor`, validates month + non-empty reason, 404/401 handling).
3. **事業目的 (BusinessPurpose) column** on the accountant-facing 照合CSVs (`lib/receipts/reconciliation-files.ts`): added after `科目＆No.` in `AMEX_RECONCILIATION_APPEND_HEADERS` + `PAYMENT_PATH_CSV_HEADERS`; emitted in both builders; wired in `app/api/receipts/export/month/route.ts`. **Deliverable-format change** — accountant to be notified before next delivery (backlog-#1 category).
4. Tests: 4 new (2 unfinalize, 2 business-purpose); full suite 738 pass / 0 fail / 1 skipped; `tsc --noEmit` clean; `build:cf` exit 0.

---

## Current snapshot of 2026-06 (live D1, 2026-07-20)

| Layer | State |
|---|---|
| `amex_reconciliations` | **`status=finalized`** (`finalized_at=2026-07-12`, by david.klan@gmail.com) — **never unfinalized**. The Part-3 unfinalize curl was not confirmed to have taken effect (see "misleading signal" below). |
| `receipt_exports` | rev1 **finalized** (07-12); rev2 **finalized** (07-15, reason "tranche1"); **rev3 DRAFT** (07-18, reason "Draft 2 submit for review"). |
| `receipt_records` | **33 receipts** in 2026-06 scope, **all `status=exported`**, none editable or deletable via any API route today. |

**Pending Part-4 edits (NONE applied — all blocked):**
- **a** — `business_purpose = "交通系ICカードチャージ(Klan)"` on 4 CASH IC-card top-up receipts: `0802caae-5c18-4f71-86db-364e9d9b3264` (06-02), `ca757eb0-98a6-41ea-b87b-9c2b98c55b43` (06-11), `113480df-66d9-431e-83fa-ac1c5f482748` (06-22), `e47e27a7-2152-4755-abb6-17cc994ef993` (06-27).
- **b** — delete ¥60 CASH receipt `4af7dea8-2dba-479d-971c-e874e6895f19` (2026-06-22, セブン-イレブン 東中野末広橋店).
- **c** — attendees on May-1/May-2 charges (AMEX lines in the June statement; 10 lines total, 9 distinct receipts; receipt-level attendees today via `receipt_attendees`, 0 line-level). David to specify which + names.
- **d** — expense-category changes on specific receipts. David to specify.

**Operator decisions on record:** leave 2026-06 open; David finalizes manually later; beta — nothing shipped to the accountant.

---

## The monthly seal & locking system as-built

The authoritative design description is the header of `lib/receipts/receipt-locks.ts`
(L1–23, "split-lock model, audit A5"). Two independent locks own **disjoint
populations**:

1. **EXPORT lock** — `isMonthLockedForEdits` (`lib/receipts/month-lock.ts`) +
   `loadSealedExportMonths`. Applies to **non-AMEX** receipts' transaction month.
   **F1 carve-out**: finalized export + open draft → **released**.
   → 2026-06: **RELEASED** (rev3 draft exists). `month-lock.test.ts` F1 covers this.
2. **RECONCILIATION lock** — `rejectIfReceiptInFinalizedReconciliation`
   (`db.ts` ~L2966) + `isAmexLikeForLock` (`receipt-locks.ts:101`). Applies to
   **AMEX/UNKNOWN** receipts matched to a finalized `amex_reconciliations` line.
   **No carve-out** — finalize is the seal; `unfinalizeReconciliation` (new) is the
   manual reverse.
   → 2026-06: **ENGAGED** (reconciliation finalized) for AMEX receipts matched to June lines.

…plus a **third gate that is NOT in the documented split model**:

3. **Per-receipt STATUS gate** — `PATCH app/api/receipts/[id]/route.ts:98`
   (`if (receipt.status === "exported" || "archived") → 409`) and `DELETE`
   (`softDeleteReceipt` `db.ts:565`, refuses any status outside
   `captured/needs_review/reviewed`). **Hard status check, no draft carve-out.**
   → 2026-06: **ENGAGED** for all 33 exported receipts.

Supporting facts:
- `hardDeleteReceipt` (`db.ts:186`) exists — **no status gate**, cascades
  (nulls AMEX line refs, deletes files/attendees/record, writes audit with
  reason) — but has **no public route**. The `DELETE` route calls `softDeleteReceipt`
  instead. So there is **no API path at all** to remove an exported receipt.
- Receipt status lifecycle writes: →`reconciled` (`db.ts:1296/1312`), →`needs_review`
  **only from `reconciled`** (`db.ts:1334`), →`exported` (`finalizeExport` `db.ts:2880`).
  **Nothing anywhere reverts a receipt off `exported`.**
- `createExportRevision` (`db.ts` ~L2925) inserts a draft `receipt_exports` row +
  audit; it does **not** touch `receipt_records`. So opening a revision does not
  unfreeze the receipts.

---

## Gaps & inconsistencies (core findings)

1. **Gate #3 is an undocumented third lock with no carve-out — it overrides the
   designed model.** While rev3 draft is open, the EXPORT lock (#1) says
   "editable," but gate #3 says "locked"; the stricter one wins, so exported
   receipts stay frozen. **This is the direct Part-4 blocker.**
2. **Nothing reverts `status` off `exported`** ⇒ a shipped receipt is permanently
   immutable via API. The revision flow's own error message ("POST
   …/export/<month>?correction=true to create a revision") is **self-defeating for
   data edits**: `createExportRevision` opens a draft but changes no receipt, so
   creating the revision does not unfreeze anything. The revision flow has only
   ever been used for **format/regeneration** (rev2 = proofs ZIP / No-column
   transition), never for editing exported receipt data. Missing link: either
   (a) add the F1 carve-out to gate #3, or (b) revert receipt status when a draft
   opens.
3. **`unfinalizeReconciliation` (shipped this session) reverses only gate #2.** It
   does not release the export lock (#1) or receipt status (#3). "Unfinalize the
   reconciliation" therefore never makes a month fully editable on its own — which
   is exactly what the operator hit ("the reversal didn't clean the receipts").
4. **DELETE vs PATCH gates diverge from each other and from the F1 model.** Both
   key on `status='exported'`; neither is draft-aware.
5. **`hardDeleteReceipt` is unreachable.** The one function that could delete an
   exported receipt (no status gate) has no route; the DELETE route soft-deletes
   instead. No API path removes an exported receipt.
6. **Reconciliation lock has no F1-style carve-out**, unlike the export lock —
   finalized reconciliation = AMEX receipts frozen until a *manual* unfinalize.
   Inconsistent with the export lock's draft-aware design.

---

## Why the step-3 "PATCH works" signal was misleading

During Part 3, one June receipt PATCH reportedly succeeded and was taken
(incorrectly) as proof the unfinalize had worked. The DB now shows the
reconciliation was **never unfinalized**. The edit succeeded because of the
split-lock model, not the unfinalize: the edited receipt was non-AMEX (subject
to the EXPORT lock #1, which rev3's draft releases) and was not `status=exported`
(dodged gate #3). Lesson: a successful PATCH is **not** evidence the
reconciliation lock is released — only that the specific receipt fell outside
both engaged locks.

---

## Request: full review + unified revision plan

Open design questions for the architect (not an exhaustive list):

- **Single "reopen month for correction" action?** Today the operator must reason
  about 3 independent locks to edit a sealed month. Should one action reverse all
  applicable locks (unfinalize reconciliation + ensure an open export draft +
  unfreeze receipt status / relax gate #3)?
- **How should data edits on exported receipts work?** Candidate fixes: (a) add
  the F1 carve-out to gate #3 (`PATCH route.ts:98` + `DELETE db.ts:565`) so an open
  draft unfreezes exported receipts; (b) revert receipt status off `exported` when
  a draft opens (in `createExportRevision` or the rebuild). Which — or both — and
  how do they interact with `finalizeExport` re-stamping on re-finalize?
- **Reconciliation lock carve-out?** Should it become draft-aware (F1-style) for
  consistency with the export lock, so opening a revision also releases AMEX
  receipts without a separate manual unfinalize?
- **Expose `hardDeleteReceipt` (or relax soft-delete under a draft)?** Today there
  is no API path to remove an exported receipt — the ¥60 delete (Part 4b) is
  impossible as-is. Decide the intended operator model for removing a receipt
  that already shipped.
- **Reconcile implementation vs the documented model.** `receipt-locks.ts` L1–23
  describes a clean 2-lock split; gate #3 and the unreachable `hardDeleteReceipt`
  break it. Either bring the code in line or update the model + the review-queue
  lock surface to match.

## Constraints / context for the plan

- Beta; nothing has been delivered to the tax accountant. 2026-06 is to remain
  open until David finalizes manually.
- The Part-4 edits above (a/b/c/d) are the concrete unblock targets — the plan
  should let them land.
- `unfinalizeReconciliation` + the `/unfinalize` route (shipped, PR #139) are
  available building blocks; fold them into the unified model rather than
  re-creating.
- The 事業目的 column (PR #139) changes the 照合CSV deliverable format — separate
  accountant-notice item, but relevant if the revision plan touches export format.
