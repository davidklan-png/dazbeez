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
- **CASH/DIGITAL receipts** ship by **statement-cycle membership** (ADR 0006): each receipt has a stored `export_statement_month` — the cycle its `transaction_date` falls in. `window(M) = (close(M-1), close(M)]` where `close(M)` = MAX `transaction_date` over statement M's AMEX lines, zero slack. A cash receipt dated May 3 belongs to the 2026-06 cycle (Apr 11 – May 7) and ships in **June** — the same cycle as the AMEX lines, not the calendar month of its date.

The export bundle is still `buildExportBundle(month)`; PR #2 flipped it to select CASH/DIGITAL by `export_statement_month` instead of `transaction_date LIKE`. The **Additional charges** section header now shows the cycle range and receipt count (e.g. "June 2026 cycle · Apr 11 – May 7 · 0 receipts"). UNKNOWN-path receipts are excluded and block finalize.

Membership is sticky: assigned once (at capture, when a date is first set, or by the AMEX-import sweep) and never re-derived — if a re-import shifts a close, existing assignments stay put and a drift warning is logged. Receipts dated beyond the newest imported statement's close are **awaiting** (NULL); undated cash/digital receipts are **unassignable** — see below.

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

## Membership states & override (ADR 0006)

**Awaiting statement** — dated CASH/DIGITAL receipts past the newest imported statement's close (`export_statement_month` NULL). Shown on the export page. Self-resolving: the next AMEX import whose window covers the date assigns them via the import sweep.

**Unassignable** — cash/digital receipts with no `transaction_date`. These can never be assigned and are invisible to every membership query. Needs-attention on the export page; deep-link to the receipt and set a date.

**Late-receipt roll-forward** — a receipt captured after its covering month's export shipped is rolled forward to the next **open** statement month (audited `receipt.export_statement_month_rolled_forward`). "Open" = the export is not finalized (two-lock model: the **export** seal, not the reconciliation seal).

**Discretionary override** — on a receipt's edit view (CASH/DIGITAL only), the "Statement month" control reassigns `export_statement_month` to a different **open** month. Blocked for sealed months (the export already shipped — use the revision flow). A confirm dialog states the consequence; audited as `receipt.export_statement_month_overridden`.

**Drift warning** — if a statement re-import shifts a close date, existing assignments are held fixed (sticky); each mismatch is logged (`receipt.export_statement_month_window_drift`) and surfaced as a non-blocking warning. Override to correct if needed.

## Sealing 2026-06 (current state)

After ADR 0006 (PR #1–#3), 2026-06's export is **AMEX-only**: its 10 June-dated cash receipts belong to the 2026-07 cycle (window Apr 11 – May 7 has 0 cash) and now ship in July. The June review page's Additional Charges section is empty with the cycle range in the header. Reconciliation is sealed; gates pass. Click path: export screen → Rebuild draft → "Review & finalize" → confirm 0 additional charges → type "june 2026" → Finalize.

## Starting 2026-07

2026-07 is the open month: 20 statement lines, 14 uncategorized, 3 confirmed.
Run the reconcile → review → rebuild → review-page → finalize flow above. The
manifest-preview header will show "July 2026 statement · <window> · N rows" so
you can tell it apart from 2026-06.
