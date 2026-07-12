# Month-close runbook — receipts export

The operator's procedure for sealing a monthly AMEX statement export, as it
actually works today. Accurate to shipped behavior. The single enforcement
authority is `validateMonthReadyForExport` (the finalize gate); the export
screen's blocker tile mirrors it via shared predicates.

## TL;DR — the click path

1. **Reconcile** — `/receipts/reconcile?month=YYYY-MM`: match AMEX statement lines to captured receipts, categorize every line, resolve missing-receipt reasons.
2. **Review orphans & cash** — `/receipts/review`: mark captured receipts reviewed; classify any `payment_path=UNKNOWN` receipts as AMEX/CASH/DIGITAL.
3. **Sign off reconciliation** — `/receipts/reconcile` → finalize reconciliation (seals the statement match).
4. **Rebuild draft** — `/receipts/export?month=YYYY-MM` → "Rebuild draft" (stages the CSV + manifest in R2, writes `bundle_built_at`).
5. **Pre-finalize review** — click "Review & finalize" → `/receipts/export/YYYY-MM/review`: summary, side-by-side reconciliation, additional charges (cash/digital), business trips, and the gate verdict at the top.
6. **Finalize** — bottom of the review page: type the month label, click Finalize. Irreversible.

The export page (`/receipts/export`) is the status/blockers hub; the review
page is where you actually seal. Finalize is operator-only — no automated
path calls `finalize=true`.

## The statement month vs transaction dates

An AMEX statement labeled `YYYY-MM` covers a **~6-week transaction window that
lags the label** — e.g. the 2026-06 statement contains lines dated Apr 10 –
May 7. The export bundle is scoped by **`statement_month`** (not
transaction_date), so a June-statement line dated in April is correct and
ships in the June export. The manifest-preview header restates the window
("June 2026 statement · Apr 10 – May 7 · 42 rows") to avoid confusing this
with the next month's statement.

Rows in the bundle = AMEX statement lines + in-month CASH/DIGITAL receipts
(matched receipts appear once on their line; UNKNOWN-path receipts are
excluded and block finalize).

## Blockers — what each means and where to fix it

The export screen's tile and the review page's gate verdict share the same
rule definitions. If the tile shows a blocker, the gate will enforce it.

| Blocker | Meaning | Deep link / fix |
|---|---|---|
| Uncategorized AMEX lines | A line has no category (and no matched receipt carrying one). | `/receipts/reconcile` — categorize the line. |
| Receipts with unknown payment path | A captured receipt is `payment_path=UNKNOWN` (excluded from the bundle). | `/receipts/review?payment_path=UNKNOWN` — classify AMEX/CASH/DIGITAL. |
| Unreviewed receipts | A receipt is `status=needs_review` (not pending extraction). | `/receipts/review?status=needs_review` — mark reviewed. |
| Receipts pending processing | Captured but extraction still queued (no field key yet). | Drain the Mac MLX consumer queue — not a review action. |
| Entertainment/meeting lines need attendees | A confirmed entertainment/meeting line has no attendees recorded. | `/receipts/reconcile` — link a receipt with attendees. |
| Lines marked "missing receipt" without a reason | `receipt_status=missing_receipt` (or no-receipt-required) with no reason. | `/receipts/reconcile` — add a brief reason. |
| No finalized reconciliation | Reconciliation not signed off for the month. | `/receipts/reconcile` → finalize reconciliation first. |
| CASH/DIGITAL receipt missing field | A non-AMEX receipt in the bundle is missing date/merchant/amount/category. | `/receipts/review/<id>` — complete the fields. |
| Compliance blocker / warning | Open compliance-engine checks on the month's receipts. | Resolve in the compliance UI; warnings only block if `export_block_on_warnings=true`. |
| Cross-month match | A receipt is matched to AMEX lines in two different statement months. | Disambiguate the match in reconcile so the receipt belongs to one statement. |
| Business-trip candidate | A line is flagged as a trip candidate, unresolved. | `/receipts/reconcile` — confirm or dismiss the trip cluster. |

## Rebuild vs finalize

- **Rebuild draft** (export screen) is safe to repeat: regenerates the CSV +
  manifest in R2, replaces `receipt_export_items`, advances "Last draft built"
  (`bundle_built_at`), and writes an `export.generated` audit entry. It does
  NOT change receipts/lines, so it cannot change blocker counts.
- **Finalize** (review page) is irreversible: sets the export to `finalized`,
  locks the receipts to read-only, marks the AMEX statement reconciled, stamps
  `exported_month` on shipped receipts, writes `export.finalized` + per-receipt
  `receipt.exported` audit entries.

If finalize 400s with "Export bundle has not been generated yet", you haven't
rebuilt since the last deploy — click Rebuild first (it persists the archive
keys the finalize route checks).

## Sealing 2026-06 (current state)

2026-06 is clear to seal: reconciliation sealed, 0 uncategorized, 0
unreviewed, 0 UNKNOWN-path, 0 cross-month matches. Click path: export screen →
Rebuild draft → "Review & finalize" → review page → type "june 2026" →
Finalize.

## Starting 2026-07

2026-07 is the open month: 20 statement lines, 14 uncategorized, 3 confirmed.
Run the reconcile → review → rebuild → review-page → finalize flow above. The
manifest-preview header will show "July 2026 statement · <window> · N rows" so
you can tell it apart from 2026-06.
