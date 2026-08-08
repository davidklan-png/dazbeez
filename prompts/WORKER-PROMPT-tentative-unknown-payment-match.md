ROLE: You are the WORKER in a two-agent workflow. The ARCHITECT (a separate
sandboxed session) designed the following change and needs it implemented,
verified against live bindings, and reported back — not redesigned. If you
hit a design decision this prompt doesn't cover, stop and report back
instead of improvising.

# Tentative AMEX matches for receipts with no payment path declared yet

## Problem

`matchAmexToReceipts` (`lib/receipts/reconciliation.ts:163`) only considers
a receipt as an AMEX-line candidate when `receipt.payment_path === "AMEX"`.
A receipt still sitting at `payment_path === "UNKNOWN"` (not yet classified
by an operator) is invisible to the matcher even when merchant, amount, and
date obviously line up — the operator has to classify it as AMEX in the
review screen first, then come back to reconcile and confirm the match as
a second, separate step. Operator request: let the matcher suggest these
too, and let confirming the suggestion do the classification (set
`payment_path = 'AMEX'`) as part of the same action.

## Decisions already made with the operator (do not revisit)

1. **Scope: `UNKNOWN` only.** Receipts already classified `CASH` or
   `DIGITAL` are NOT reconsidered as AMEX candidates by this change — that
   would mean second-guessing an explicit human classification, a much
   bigger and riskier change than "help classify something nobody has
   looked at yet." Out of scope here.
2. **Confirming sets `payment_path = 'AMEX'` atomically with the match
   confirmation.** One click both classifies and reconciles. This also
   happens to clear the existing export blocker
   (`lib/receipts/blockers.ts:39-43` `isUnknownPathReceipt`) as a natural
   side effect — don't special-case that, it just falls out of the fix.
3. **Hard safety requirement — confidence cap.** The reconcile screen has
   an existing "bulk-confirm obvious matches" action
   (`components/receipts/reconcile/reconcile-screen.tsx:270-306`,
   `bulkConfirmObvious`) that auto-confirms EVERY line scoring ≥0.92
   ("obvious" band, `lib/receipts/confidence.ts:9-14`) with no individual
   review. Without a cap, a receipt with a perfect exact-amount/same-day/
   merchant match could reach that score purely on its own signals and get
   silently swept into a bulk action, reclassifying it as AMEX without a
   human ever looking at that specific line. The codebase already solved
   this exact problem for consolidated multi-line matches
   (`CONSOLIDATED_CONFIDENCE_CAP = 0.9`, `reconciliation.ts:55` — kept
   below the 0.92 "obvious" threshold specifically to force individual
   confirmation). Reuse that pattern: every tentative UNKNOWN-payment-path
   match must be capped below 0.92, with NO exceptions, so it can never be
   bulk-confirmed. Treat this as the load-bearing constraint of this whole
   change, not a nice-to-have.

## 1. `lib/receipts/reconciliation.ts` — eligibility + capped scoring

- Rename or add alongside `CONSOLIDATED_CONFIDENCE_CAP` (line 55) a shared
  constant, e.g. `MANUAL_REVIEW_CONFIDENCE_CAP = 0.9`, used by BOTH the
  existing consolidation cap and this new path — single source of truth for
  "this match category must never auto-confirm." If renaming
  `CONSOLIDATED_CONFIDENCE_CAP` ripples too far, adding a second constant
  with the identical value and a comment cross-referencing the other is
  acceptable — just don't let the two drift independently over time.
- Relax the gate at line 163 from `if (receipt.payment_path !== "AMEX")
  continue;` to also admit `receipt.payment_path === "UNKNOWN"`. Track a
  `tentativePaymentPath` boolean for the receipt in this iteration.
- This must compose with the existing same-currency AND foreign-currency
  (migration 0026) eligibility paths — an UNKNOWN-payment USD receipt
  (e.g. an unclassified Cloudflare/Anthropic receipt) should now be able to
  match via the foreign-currency path too, still capped the same way.
- At the score-cap step (mirrors the existing `Math.min(score, dateCap)`
  around line 232), additionally cap at `MANUAL_REVIEW_CONFIDENCE_CAP` when
  `tentativePaymentPath` is true.
- Add a distinguishing reason string, e.g. `"payment path not yet set —
  confirming will classify as AMEX"`. If both the tentative-path AND the
  foreign-currency path apply to the same match, compose both reasons
  (e.g. `"payment path not yet set — confirming will classify as AMEX",
  "exact amount (foreign currency)"`) — don't let one silently overwrite
  the other.
- **Scope this to Phase 1 (1:1 matching) only.** Do not extend to the
  Phase 3 consolidation block — matches the earlier decision to keep
  consolidation JPY-only/AMEX-only for now (real foreign/tentative cases
  today are single-line subscriptions). If threading this through
  consolidation seems necessary once you're in the code, stop and confirm
  with the architect rather than expanding scope.

## 2. `lib/receipts/db.ts` — confirm-time payment_path flip

In `updateAmexReconciliation`, inside the `matchStatus === "confirmed"`
branch (~line 1179 onward):

- The existing receipt-row SELECT (~db.ts:1182-1187) already reads
  `merchant`/`transaction_date` for the overwrite decision — extend it to
  also read `payment_path`.
- When the current `payment_path === 'UNKNOWN'`, include `payment_path =
  'AMEX'` in the `UPDATE receipt_records` statement in BOTH branches (the
  merchant-changed branch ~1202-1218 and the no-op branch ~1221-1227).
  Gate strictly on `payment_path === 'UNKNOWN'` at read time — a receipt
  already `CASH`/`DIGITAL`/`AMEX` must never have its payment_path touched
  by this code path, confirmed or not.
- This write must land in the SAME batch/transaction as the match
  confirmation — a receipt must never be observable as
  `matched_receipt_id` set + `payment_path` still `'UNKNOWN'`, even
  transiently.
- Add a note on the existing `createAuditEntry` call (~db.ts:1264-1295)
  recording that payment_path was classified as AMEX via reconciliation
  confirm, consistent with this project's audit-everything convention —
  this needs to be traceable later, not an invisible side effect.

## 3. Regression guard — bulk-confirm must never touch these

Add an explicit test (not just incidental coverage) asserting: a synthetic
UNKNOWN-payment receipt with exact-amount + 0-day + merchant-match signals
— which would score ≥0.92 on raw signals alone — classifies via
`bandForLine` to something OTHER than `"obvious"` once capped. This is the
regression gate for §1's hard requirement; treat a failure here as a
blocker, not a nice-to-have.

## 4. UI

- `lib/receipts/confidence.ts` `matchExplanation`: add a branch for
  tentative UNKNOWN-payment matches explaining that confirming will also
  set payment path to AMEX, so the operator isn't surprised by the side
  effect. Compose with the existing foreign-currency branch when both
  apply (see §1).
- `components/receipts/reconcile/reconcile-screen.tsx`: add a distinct pill
  (e.g. `tone="blue"`, "Payment path not set — confirms as AMEX") in both
  the `LineRow` list-row rendering and the `DetailPane` comparison card,
  mirroring how the migration-0026 "currency unparsed" pill was added in
  the same two spots.

## 5. Tests

- `reconciliation.test.ts`:
  - UNKNOWN-payment receipt with exact amount/date/merchant now appears as
    a candidate (previously fully excluded); confidence capped below 0.92
    even though raw signals would clear it; reason string present.
  - A CASH or DIGITAL receipt with identical exact-match signals is still
    NOT considered — confirms scope stays UNKNOWN-only.
  - UNKNOWN-payment USD receipt against a parsed-foreign-currency JPY line
    (migration 0026 path) now matches, capped, with composed reasons.
  - §3's band regression test.
- `db.ts` reconciliation tests: confirming a match for an UNKNOWN-payment
  receipt flips `payment_path` to `'AMEX'` in the same write; confirming a
  match for an already-`AMEX`/`CASH`/`DIGITAL` receipt leaves
  `payment_path` untouched; audit entry recorded.
- Full existing suite: zero regressions, particularly for already-declared
  AMEX matches and untouched CASH/DIGITAL receipts.

## 6. Verification & report (required)

Against live bindings:

1. Find (or manufacture) a receipt currently at `payment_path = 'UNKNOWN'`
   with a plausible AMEX-line counterpart. Confirm it now surfaces as a
   tentative candidate with a capped score and the correct reason text,
   BEFORE any manual reclassification.
2. Confirm it via the UI (or API). Verify: `payment_path` flips to
   `'AMEX'`, `match_status` becomes `'confirmed'`, an audit entry is
   recorded, and the receipt no longer trips the UNKNOWN export blocker.
3. Manufacture a case that would score ≥0.92 on raw signals with an
   UNKNOWN-payment receipt (perfect amount/date/merchant). Confirm it does
   NOT appear in "Bulk-confirm obvious" candidates and is NOT touched by
   that action.
4. Confirm existing declared-AMEX matches and CASH/DIGITAL receipts are
   completely unaffected (same scores, same bands, no payment_path churn).
5. `npm test`, `tsc --noEmit`, `npm run build:cf` clean.

Report back: which receipt(s) you used for step 1–3, before/after
`payment_path`/`match_status` values, test counts, and explicit pass/fail
per step above. Flag anything ambiguous (e.g., if composing the
foreign-currency + tentative-path reason strings gets awkward, or if no
real UNKNOWN-payment receipt exists to test against and you had to
manufacture one) rather than improvising past it. Do not deploy — the
architect verifies independently before deploy.
