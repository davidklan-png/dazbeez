# ADR 0014 — Receipt month-membership authority (gates derive scope, never dates)

Status: Accepted (2026-10-06, operator directive after the 2026-09 close)
Supersedes: none; sharpens ADR 0008 (membership) and backlog #8 (upcoming vs orphan)

## Context

Closing 2026-09 (2026-10-06), an unmatched AMEX receipt (リカーBOSS, extracted
date 2026-09-08, filename explicitly `接待交際費AMEX-Oct2026払い`) blocked the
2026-09 finalize gate. Its charge sits on the already-imported **2026-10**
statement (line dated 2026-08-18, ¥12,175). The same class hit 2026-08
(izmicworld, 2026-08-31). This card's statement months lag the calendar by
~2 months, so an extracted transaction date and the shipping month routinely
disagree.

Root cause: no written rule said which month *owns* a receipt, so the
compliance gate's calendar sweep (`transaction_date LIKE month%`) filled the
vacuum and contradicted the statement month. Operator ruling: **the monthly
closing pattern is enforced by rules, not heuristics — a simple classification
input must never be able to block the wrong month.**

## Decision

Every receipt ships in **exactly one** month, decided by payment path:

| Path | Shipping month = | Enforced by |
|---|---|---|
| CASH / DIGITAL | `export_statement_month` (calendar-month assignment at capture/import; discretionary D6 override) | membership.ts; gate 3 / gate 2.5 via bundle |
| AMEX (matched) | the **statement month of its matched line** | bundle membership → gates 2.5/3/5 via `extraReceiptIds` |
| AMEX (unmatched) | **none — "upcoming"** (backlog #8) | may not block ANY month; becomes enforceable when matched, or when its line is resolved `no_receipt`-with-reason at that statement's signoff (line-side gate) |
| UNKNOWN | no shipping month; gates month M if its calendar date falls in M (until classified) | gate 2 / `listUnknownInScopeReceipts` |

Rules:

1. **Gates derive scope from these authorities only.** No gate, tile, or
   rollup may scope AMEX-path receipts by `transaction_date`. The one
   calendar sweep that did (the compliance month filter) excludes
   `payment_path = 'AMEX'` since 2026-10-06.
2. **An unmatched AMEX receipt blocks nothing.** It is upcoming, not an
   error. The statement-side gate provides the counter-pressure: a statement
   month cannot sign off while a line is unmatched-without-reason, so the
   match (or no-receipt decision) is forced at the line's own month.
3. **Display surfaces are exempt** (review queue month filter, rail working
   sets): they may show a receipt under a calendar month for data entry.
   Closing authority is the gates, not the views.

## Enforcement

- `tests/receipts/month-membership-contract.test.ts` — source-reading
  contract test (house pattern, cf. amex-import-contract) pinning rule 1:
  the compliance month sweep must exclude AMEX-path receipts.
- Re-review: any new gate/rollup over receipts must state its scope rule in
  terms of this table; reviewers reject date-proximity scoping for AMEX.

## Consequences

- A receipt captured with a wrong extracted date can no longer block the
  wrong month's finalize (the incident class is closed at the gate).
- An unmatched AMEX receipt's data-quality blockers (missing category, etc.)
  surface on the receipt itself (review page, per-receipt compliance) and at
  its OWN month's close — not on whichever month its date resembles.
- The review queue may still *show* such a receipt under a calendar month;
  its blockers there are per-receipt truth, not month-gate truth.
