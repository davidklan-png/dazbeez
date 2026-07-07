# ADR 0005 — 3–4 concurrent open months operating assumption

- **Status:** Accepted
- **Date:** 2026-07-08
- **Owner:** David (PM)
- **Affects:** `lib/receipts/month-closing.ts`, `lib/receipts/db.ts`, `db/receipts/0017_export_integrity.sql`, `app/(receipt-system)/receipts/export/page.tsx`
- **Audits:** 2026-07-08 export review (activity A7)
- **Retires:** the pre-2026-07-08 "at most 2 open months" assumption documented in AGENTS.md

## Context

The previous operating assumption was "at most 2 statement months open at a time" — when a new month starts, the previous month should already be closed. That constrained the hot working set and let the design rely on near-sequential close.

AMEX statement windows lag the statement label by ~6 weeks, so when 3–4 months are active the windows **overlap** — a receipt dated in late March can plausibly be a candidate for both the March and April statements. The 2-month assumption quietly broke: with overlapping windows, the same receipt could be suggested as a match for lines in two open months, and the export pipeline had no way to detect or block the ambiguity.

A receipt matched to AMEX lines in two statement months is not a harmless double-count — it means both months' bundles would include the same receipt (once on each month's line row), and both finalized bundles would claim SHA-256 immutability over a row that exists in two places.

## Decision

The module is designed for **up to 3–4 concurrent open months** with overlapping statement windows.

Two concrete enforcements:

1. **Cross-month match integrity blocker.** `validateMonthReadyForExport` (in `lib/receipts/month-closing.ts`) groups all AMEX lines by `matched_receipt_id` and blocks finalize for any receipt that appears in more than one distinct `statement_month`. Both months stay blocked until the operator disambiguates (unmatch from one month, or reclassify).

2. **Out-of-order finalize is allowed, with a warning.** Sealing April while March is still open is legitimate. But a late cash/digital receipt dated in March will cost a revision once it lands. `computeEarlierOpenMonthWarnings(month)` returns one warning string per earlier open month; both finalize routes (`/api/receipts/export/month` and `/api/receipts/export/[month]`) surface these in the finalize response as a non-blocking `warnings: string[]` field.

Supporting design points:

- **Draft isolation** is per-month. Migration 0017's `idx_exports_one_draft` is a partial unique index on `receipt_exports(export_month) WHERE status = 'draft'` — multiple months may each hold a draft concurrently. No code path assumes a single global draft.
- **Subrequest budget.** The export page issues ~12 D1 queries per render (month switcher aggregates + bundle build + display queries), all batched via `Promise.all` where independent. Workers' 50-subrequest budget leaves ample headroom at 4 open months.
- **Per-month query batching.** `listAttendeeNamesByReceiptIds(allReceiptIds)` is one batched call across all receipts in the bundle, replacing the previous per-receipt `listAttendees` N+1. At 4 open months with ~50 receipts each, this collapses ~200 queries to 1.
- **`listAllReceiptsInMonth`** pages internally with a hard cap (default 10 000 rows). Silent truncation would corrupt a bundle; hitting the cap raises explicitly so the operator knows.

## Consequences

- Operators can safely keep multiple months open during catch-up or reconciliation backlogs. They get a warning when finalizing an out-of-order month, not a hard block.
- A receipt accidentally matched to two open months is loud — finalize fails on both until resolved.
- The hot working set is bounded by the operator's habits, not by code; if a fifth month opens the design still works (the assumptions are about overlapping windows, not a hard count).
- AGENTS.md "Receipts Data Lifecycle" section's 2-month guidance is superseded for export-module design; the operator-facing "close the previous month when a new one starts" habit is still recommended but no longer load-bearing.
