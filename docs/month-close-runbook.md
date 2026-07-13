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
lags the label** — e.g. the 2026-06 statement contains lines dated Apr 10 – May 7.

- **AMEX lines** ship in their `statement_month` (a June-statement line dated in April is correct).
- **CASH/DIGITAL receipts** ship by **calendar-month membership** (ADR 0008): each receipt has a stored `export_statement_month` equal to the **calendar month** of its `transaction_date` (June 1–30 → `2026-06`). A cash receipt dated June 11 ships in the **June** export, alongside the June AMEX statement — whose own lines span the *prior* billing cycle. That cycle/calendar asymmetry is intentional and operator-confirmed.

The export bundle is still `buildExportBundle(month)`; it selects CASH/DIGITAL by `export_statement_month = month`. The **Additional charges** section header shows the month and receipt count (e.g. "June 2026 · 11 receipts"). UNKNOWN-path receipts are excluded and block finalize.

Membership is sticky: assigned once (at capture, when a date is first set) and never re-derived. (ADR 0006's window rule, AMEX-import sweep, drift detection, and "awaiting statement" bucket are retired by ADR 0008 — a dated receipt is always immediately assignable to its calendar month.) Undated cash/digital receipts are **unassignable** — see below.

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
| Possible duplicate cash/digital receipts (warning) | 2+ CASH/DIGITAL receipts share merchant + amount + transaction_date. | `/receipts/review/<id>` — confirm distinct (non-blocking, no auto-dedup). |

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

## Membership states & override (ADR 0008)

**Unassignable** — cash/digital receipts with no `transaction_date`. These can never be assigned to a calendar month and are invisible to every membership query. Needs-attention on the export page; deep-link to the receipt and set a date. (This is the only NULL state left — ADR 0006's separate "awaiting statement" bucket is retired: under the calendar rule every dated receipt is immediately assignable.)

**Late-receipt roll-forward** — a receipt whose calendar month's export already shipped (and has no open draft revision) is rolled forward to the next **open** month when its date is set (audited `receipt.export_statement_month_rolled_forward`). "Open" = the export is not finalized (two-lock model: the **export** seal, not the reconciliation seal).

**Discretionary override** — on a receipt's edit view (CASH/DIGITAL only), the "Statement month" control reassigns `export_statement_month` to a different **open** month. Blocked for sealed months (the export already shipped — use the revision flow). A confirm dialog states the consequence; audited as `receipt.export_statement_month_overridden`.

## Sealing 2026-06 (current state)

After ADR 0008, 2026-06's export is **32 AMEX lines + 11 June-dated cash/digital receipts** (the calendar rule puts a June-dated cash receipt in June, alongside the June statement). The June review page's Additional Charges section lists those 11, including a **4× セブン-イレブン 東中野末広橋店 ¥10,000 on 2026-06-11** cluster — confirm the duplicate warning (distinct charges, not double-captured) before finalizing. Reconciliation is sealed; gates pass otherwise. Click path: export screen → Rebuild draft → "Review & finalize" → confirm the 11 additional charges + dismiss the duplicate warning → type "june 2026" → Finalize.

## Starting 2026-07

2026-07 is the open month: 20 statement lines + 1 July-dated cash/digital receipt
(calendar rule). Run the reconcile → review → rebuild → review-page → finalize
flow above. Reconcile the 20 lines (categorize, match receipts, resolve
missing-receipt reasons) and sign off the reconciliation before finalizing.
