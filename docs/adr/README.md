# Architecture Decision Records (ADR)

Decisions that shape the Dazbeez receipts module and adjacent subsystems. Each
ADR is a dated, status-stamped record; supersession is captured with first-class
`Supersedes` / `Superseded by` fields (see [template.md](template.md)) and kept
**bidirectional** — when an ADR supersedes another, both records point at each
other, and the superseded ADR is preserved verbatim as decision history.

## Index

| # | Title | Status | Date | Supersedes / Superseded by |
|---|-------|--------|------|----------------------------|
| [0001](0001-receipt-extraction-runtime.md) | Store-and-forward extraction runtime (Cloudflare Queue + Mac MLX consumer) | Accepted | 2026-06-09 / 2026-06-20 | — |
| [0001-brief](0001-decision-brief.md) | Decision brief that produced ADR 0001 | Approved (brief) | 2026-06-20 | — |
| [0002](0002-statement-month-export-scope.md) | Export unit = statement month | Accepted | 2026-07-08 | Supersedes the pre-redesign tx-date scope |
| [0003](0003-compliance-engine-finalize-gate.md) | Compliance engine gates finalize | Accepted | 2026-07-08 | — |
| [0004](0004-split-lock-model-cash-receipts.md) | Split lock model: reconciliation-sealed vs export-finalized | Accepted | 2026-07-08 | — |
| [0005](0005-multi-open-month-assumption.md) | 3–4 concurrent open months (no hard runtime cap) | Accepted | 2026-07-08 | Retires the pre-2026-07-08 "≤2 open months" assumption in AGENTS.md |
| [0006](0006-statement-window-membership-for-non-amex-receipts.md) | Statement-window membership for non-AMEX receipts | **Superseded in part** | 2026-07-13 | Superseded by [0008](0008-calendar-month-membership-for-non-amex-receipts.md) (in part); kept as history |
| [0008](0008-calendar-month-membership-for-non-amex-receipts.md) | Calendar-month membership for non-AMEX receipts | Accepted | 2026-07-14 | Supersedes [0006](0006-statement-window-membership-for-non-amex-receipts.md) (in part) |
| [0009](0009-sealed-month-amendment-policy.md) | Sealed-month amendment policy | Proposed (design of record, not yet implemented) | 2026-07-14 | — |
| [0011](0011-email-receipt-intake.md) | Email receipt intake (receipts@dazbeez.com via Cloudflare Email Routing, triage table before promotion, standalone worker) | Accepted | 2026-07-19 | — |

### Numbering

ADRs are numbered sequentially in the order they were written. **Numbering gaps
are permitted** — an unused number does not imply a missing or deleted record.
**No ADR 0007 was recorded**; the sequence simply jumps 0006 → 0008. Do not
back-fill a placeholder.

## Status values

- **Proposed** — design of record, not yet implemented or not yet ratified.
- **Accepted** — ratified and reflected in the running system.
- **Superseded** / **Superseded in part** — replaced (wholly or partly) by a
  later ADR; the record is kept verbatim as history.

## Authoring a new ADR

1. Copy [template.md](template.md) to `00NN-short-title.md` (next free number;
   gaps are fine).
2. Fill in Status, Date, Owner/Deciders, and `Supersedes` / `Superseded by` if
   applicable.
3. If your ADR supersedes another, update **both** records' supersession fields.
4. Do not rewrite or delete superseded ADRs — annotate them in place.
