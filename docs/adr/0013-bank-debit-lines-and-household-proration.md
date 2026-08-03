# ADR 0013 — Bank-debit statement lines (utilities) and household proration (家事按分)

- **Status:** **PARKED** (2026-08-03) — backlog only. Two hard gates before any
  design decision below is locked or any code is written:
  **(G1)** the current application is stabilized (see AGENTS.md Receipts Backlog);
  **(G2)** a real bank statement export has been inspected — see
  [Gate G2](#gate-g2--no-design-lock-without-a-real-statement-export).
  Operator decisions captured 2026-08-03; proration *presentation* additionally
  pending accountant guidance.
- **Date:** 2026-08-03
- **Owner:** David (PM)
- **Affects (planned):** new `db/receipts/0035_bank_statement_lines.sql`,
  new `lib/receipts/bank-statement.ts`, new `app/api/receipts/bank/import/route.ts`,
  `lib/receipts/types.ts`, `lib/receipts/export.ts`, `lib/receipts/proofs.ts`,
  `lib/receipts/reconciliation-files.ts`, `lib/receipts/month-closing.ts`,
  `lib/receipts/reconciliation-signoff.ts`, `lib/receipts/db.ts`,
  `app/(receipt-system)/receipts/export/`, `docs/month-close-runbook.md`
- **Builds on:** [ADR 0002](./0002-statement-month-export-scope.md) (export unit =
  statement month), [ADR 0003](./0003-compliance-engine-finalize-gate.md) (finalize
  gate), [ADR 0008](./0008-calendar-month-membership-for-non-amex-receipts.md)
  (calendar-month membership for non-AMEX), [ADR 0009](./0009-sealed-month-amendment-policy.md)

---

## TL;DR

Water / electricity / gas are paid by bank direct debit (口座振替). They have no
AMEX line and no receipt image, so today they are invisible to the module and are
handled outside the system entirely. Only a business fraction (expected ~50%, rate
TBC by the accountant) is deductible.

Two things are being added:

1. **A bank debit line is a statement line, not a receipt.** It enters via a
   monthly operator-uploaded bank CSV — the same intake shape as the AMEX
   statement import — and lands in a new `bank_statement_lines` table. It is
   emitted into the existing monthly package as a third `rowType` (`bank_line`),
   inheriting month membership, the finalize/seal gate, the export CSV, the
   proofs ZIP, and the audit log. It is deliberately **not** a fourth
   `PaymentPath` value on `receipt_records`.
2. **Proration is stored, never baked in.** Rows carry the **gross** amount plus
   a **snapshotted** business ratio; the deductible amount is derived. The system
   does not store a halved number.

Phase 1 (intake + package integration) has no dependency on the accountant.
Phase 2 (how proration is *presented* to the accountant) is blocked on their
guidance and ships separately.

## Context

### What exists

- `amex_statement_lines` + the reconcile flow: import a statement, match lines to
  captured receipts, classify orphans, sign off, finalize, seal.
- `receipt_records` with `PaymentPath = "AMEX" | "CASH" | "DIGITAL" | "UNKNOWN"`.
  Every one of these presumes a captured **file** (R2 object + `receipt_files`
  manifest row) and flows through capture → extraction queue → review queue.
- The monthly package (`buildExportBundle` → CSV + 領収書等証憑 ZIP) is the
  accountant deliverable. `ExportRow.rowType` is already
  `"amex_line" | "receipt"`.
- Category `utilities` / 水道光熱費 already exists in `expense_categories`
  (displayOrder 90) and is currently unused in practice.

### What the operator wants

Pull the monthly bank statement, identify the water / electricity / gas debits,
deduct the business fraction, and have that data appear in the monthly package
alongside the AMEX and cash/digital populations.

### Operator decisions taken 2026-08-03

| # | Decision |
|---|---|
| 1 | **Bank intake is manual download + upload.** No stored bank credentials, no automated login, no aggregator. |
| 2 | **Evidence = the bank debit line only.** Utility 請求書/検針票 PDFs are not captured. |
| 3 | **Proration rate and its treatment await the accountant.** |
| 4 | **Integrated into the existing pipeline**, not a bolt-on module appended at delivery. |

## Gate G2 — no design lock without a real statement export

**Everything under "Decision" below is provisional until a real monthly export
from the actual bank account has been inspected.** The decisions were reasoned
from how bank statements generally work, not from this bank's file. That is a
guess wearing a suit, and the parts most likely to be wrong are the parts D3 and
D4 depend on.

Do not write the migration, the parser, or the recognition rules first. Get one
month's export — ideally two consecutive months, and ideally both CSV and PDF if
the bank offers both — and answer:

| # | Question | What it would break |
|---|---|---|
| 1 | **Encoding and format.** Shift-JIS/CP932 or UTF-8? BOM? CSV, TSV, or PDF-only? Header row present and stable? | Parser. Note the ￥/CP932 lesson already learned in the proofs ZIP — assume nothing about charset. |
| 2 | **Descriptor quality.** Does a utility debit arrive as `東京ガス`, as truncated half-width katakana (`ﾄｳｷﾖｳｶﾞｽ`), or as an opaque code? Is it stable month to month? | **D3 entirely.** Rule matching on a truncated or unstable descriptor is not viable, and the ignore-by-default risk (R2) gets much sharper. |
| 3 | **Is the payee even identifiable?** Some 口座振替 rows name only the collection agent, not the utility. | D3, and possibly decision 2 (bank line as sole evidence) — if the line can't name the utility, the 請求書 may have to be captured after all. |
| 4 | **Row shape.** One row per debit, or balance-carrying rows? Debits signed, or a separate 出金 column? Any same-day aggregation? | Amount extraction, and whether gross is even recoverable per-utility. |
| 5 | **Available history.** How many months back can be exported? Many JP banks cap free retention at 3–13 months. | Whether backfill of prior months is possible at all, and how urgently. |
| 6 | **Are the utilities actually on this account and actually direct-debit?** Some are billed to a card, some to a 払込票. | The premise of the whole ADR. A utility already on AMEX needs none of this. |

Q2 and Q3 are the ones that can invalidate the design rather than adjust it. If
the descriptor is unusable, D3's rules approach collapses and the fallback is
operator-tagged lines — a different and worse UX that should be decided
deliberately, not discovered mid-implementation.

**Cheapest useful action when this comes off the backlog:** export one month,
open it, and paste the utility rows (redacted) into the design session. That
single artifact settles six questions that no amount of reasoning will.

## Decision

*(Provisional — subject to Gate G2 above.)*

### D1 — Intake: operator-uploaded bank CSV, mirroring the AMEX import

No credential storage, no browser automation, no third-party aggregator. The
operator downloads the monthly CSV from the bank and uploads it through a route
modelled on `app/api/receipts/amex/import/`.

**Why this and not automation.** Automated bank login requires persisting
credentials that can move money, and defeating OTP/2FA that exists specifically
to stop what we would be doing. Japanese retail banks change their login flows
without notice; the automation would be a permanent maintenance tax on a
once-a-month, three-line task. An aggregator (Moneytree, MF) is the legitimate
alternative but adds a paid vendor holding read access to the operating account,
and a third party in the audit trail — disproportionate for ~3 recurring debits.
**This decision is revisitable without schema change**: the import route consumes
a normalized line shape, so an aggregator could later feed the same table.

**Consequence to accept:** the monthly close now has a manual prerequisite. It
belongs in `docs/month-close-runbook.md` and should eventually be a visible item
in the month-close gate (Receipts Backlog #4), or the month will silently
finalize without its utility rows — see R1.

### D2 — Model: `bank_line`, a third rowType — NOT a fourth PaymentPath

The intuitive move is `PaymentPath = ... | "BANK"`. Rejected, on measurement:
34 source files reference `PaymentPath` / `payment_path`, with 25 literal
`"DIGITAL"` sites. More importantly the semantics don't fit — every existing
`PaymentPath` value denotes *a receipt that has an image and passed through
capture/extraction/review*. A bank debit has no image, no capture, no extraction,
and nothing to match against. Forcing it into `receipt_records` would require a
carve-out in every file-presence assumption, the review queue, the extraction
queue, the compliance checks, the duplicate machinery, and the orphan classifier
— and it would show up as a permanent orphan in Reconcile.

Structurally a bank debit is **an AMEX line that is self-evidencing**: a
statement line that needs no receipt. So:

- New table `bank_statement_lines`, sibling to `amex_statement_lines`.
- `ExportRow.rowType` gains `"bank_line"`.
- `PaymentPath` is **unchanged**. Bank lines are not receipts and never appear in
  capture, review, extraction, reconcile-matching, or orphan classification.

**Future impact:** this establishes the pattern for every future non-AMEX,
non-receipt payment rail (a second card, PayPay, a 振込 to a subcontractor) —
each is a statement source, not a receipt path. Getting this shape right once
means the second rail is a table + an emitter, not another 34-file edit.

### D3 — Line relevance: rules, not orphans

A bank statement is mostly noise: salary, transfers, tax, rent, card settlement.
Only a handful of lines are business-relevant. The AMEX orphan machinery must
**never** see bank lines — every ignored line would read as an unreconciled
problem.

Instead: an operator-maintained recognition rule set keyed on the debit
descriptor (東京ガス, 東京電力, 東京都水道局) mapping to an expense category.
Default disposition for an unmatched line is **ignored**, not orphan. This should
reuse the `merchant_category_rules` pattern from migration 0030
(system-proposes / operator-accepts) rather than growing a parallel mechanism.

**Consequence to accept:** a *silent* default. A new utility provider, or a
provider renaming its debit descriptor, produces no error — the line is quietly
ignored and the deduction is simply missing. Mitigation in R2.

### D4 — Proration: store gross + snapshotted ratio, derive the rest

Stored per line: `amount_minor` (**gross**, exactly as debited),
`business_ratio_bp` (basis points, snapshotted at assignment),
`ratio_basis` (free text: the 合理的な根拠 — e.g. "floor area 50%"). The
deductible amount is **derived at read time**, never stored.

Three properties this buys:

- **The accountant sees the arithmetic.** Gross, rate, and rationale are all on
  the row. A stored half-amount is an assertion; gross + rate + basis is an
  argument — which is what 家事按分 has to survive as under scrutiny.
- **Ratio changes don't rewrite history.** Because the ratio is snapshotted onto
  the line, changing the rate (you move, or the accountant revises it) affects
  future months only. If the ratio were looked up live from settings, a sealed
  month's figures would silently change after sign-off — a direct violation of
  ADR 0009 and the single worst failure mode available here.
- **Rounding is decided once, centrally.** Yen is integer-minor; ¥8,401 × 50% is
  not an integer. One helper owns the rounding rule (proposed: floor, i.e. round
  in the tax authority's favour) so CSV, ZIP summary, and any future UI can never
  disagree by ¥1.

`business_ratio_bp` defaults to `10000` (100%). Nothing is prorated until the
accountant's rate is entered, so Phase 1 is safe to ship ahead of their answer.

### D5 — Month membership: debit date, per ADR 0008

A bank line's export month is the **calendar month of the debit date** —
consistent with ADR 0008's rule for non-AMEX receipts.

**Known asymmetry, accepted:** a gas bill debited 25 July covers June usage. Books
will therefore show 11 utility debits in a calendar year with a one-month lag, not
12 usage months. This is standard 現金主義-flavoured treatment for a small
business and matches how the AMEX cycle/calendar asymmetry is already handled, but
it is a question to put to the accountant alongside the rate (Q2 below). The
schema carries an optional `service_period_start` / `service_period_end` so the
answer can change presentation without a migration.

### D6 — Package integration: fourth ZIP folder + gross/ratio/net columns

- Proofs ZIP gains `口座振替分/` beside `AMEX明細分/`, `現金分/`, `デジタル分/`.
  It contains **no image files** (per decision 2, the bank line is the evidence)
  — only the 照合CSV for bank lines. The folder exists so the accountant sees the
  population is accounted for rather than absent.
- Export CSV gains `GrossAmount`, `BusinessRatio`, `DeductibleAmount`,
  `RatioBasis`. These are **additive columns** — and per the standing rule, the
  accountant gets a heads-up on any column-layout change before the delivery that
  carries it (this bit us on the `ExpenseType` removal).
- 集計.csv gains a 口座振替 section.
- Per the accountant-facing copy rules: no revision/internal-process language in
  お知らせ.txt — the bank section reads as first-delivery copy.

### D7 — Finalize gate: bank lines are in scope

`validateMonthReadyForExport` must consider bank lines. Minimum checks: every
recognized bank line has a category; every prorated line has a non-empty
`ratio_basis`. Sealing a month seals its bank lines under ADR 0009 like anything
else.

**This is the whole point of decision 4.** A separate module stapled on at
delivery would leave utility figures mutable after sign-off, and the sealed
manifest hash would not cover them — meaning the package could no longer prove
what was delivered. Non-negotiable.

### D8 — Phasing

| Phase | Content | Blocked on |
|---|---|---|
| **A** | Migration, import route, recognition rules, `bank_line` rowType, export CSV + ZIP folder + finalize gate. Ratio fixed at 100%; no proration visible. | Nothing |
| **B** | Enter the accountant's ratio, enable prorated columns and 集計 presentation. | Accountant (Q1–Q3) |
| **C** | Month-close gate item "bank statement imported"; descriptor-drift warning (R2). | Phase A |

Phase A is independently deliverable and independently correct: it puts the
utility debits in the books at 100%, which is strictly better than today's
"absent entirely", and never produces a wrong deduction because it produces no
deduction.

## Risks

- **R1 — Silent omission.** Nothing today forces the bank CSV to be imported
  before finalize. A month can seal with zero utility rows and look perfectly
  healthy. Phase C addresses this; until then it is runbook discipline.
- **R2 — Descriptor drift.** D3's ignore-by-default means a renamed debit
  descriptor loses a deduction with no signal. Proposed mitigation: flag when a
  *previously-seen* recurring descriptor is absent from a month's import — absence
  of an expected line is the detectable event, not presence of an unknown one.
  This mirrors the error-surfacing doctrine of Backlog #12: failures must
  announce themselves.
- **R3 — Ratio defensibility.** `ratio_basis` is free text and unvalidated. A
  blank or hand-waved basis is the thing a tax audit attacks. The finalize gate
  (D7) requires non-empty; it cannot require *good*.
- **R4 — Scope creep into a general ledger.** Once bank lines are importable,
  rent, phone, and internet are one rule each away — and then the module is
  drifting from "receipt evidence system" toward bookkeeping. Hold the line at:
  the module records *evidence and deduction basis*, the accountant keeps the
  ledger.

## Open questions for the accountant

1. **Rate and basis** for 水道光熱費 — 50%? On what basis (floor area, hours)?
2. **Timing** — is the debit date the correct booking date (D5), or should the
   service period drive it?
3. **Presentation** — does the accountant want the gross figure with the rate
   shown (system-derived deductible as reference), or the gross only, applying
   proration themselves at their end? This determines whether `DeductibleAmount`
   is an authoritative column or an informational one.

Phase B does not start until 1–3 are answered.
