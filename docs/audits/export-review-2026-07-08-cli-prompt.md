# CLI Agent Prompt — Export Module Remediation (2026-07-08 architecture review)

Copy everything below the line into the CLI agent. Work on a branch from `main`. Activities are ordered; do not reorder. A1–A3 are correctness fixes, A4–A6 are the redesign, A7 covers multi-open-month operation, A8 is verification.

Operating assumptions (from the PM): up to 3–4 statement months may be open concurrently (previous assumption was 2). Statement windows lag ~6 weeks, so open windows overlap — code must not assume a receipt has exactly one candidate month.

---

You are working in the Dazbeez repo on the receipts export module. Follow AGENTS.md conventions (App Router, server components, D1 via `lib/receipts/db.ts`). All changes must pass `npx tsc --noEmit` and `npm run build:cf`. Write unit tests with mocked bindings where a pure function is touched. Do not modify finalized-export rows or any R2 archive semantics — preservation principle: prior revisions stay untouched.

## A1 — Single validation authority (correctness, do first)

`app/api/receipts/export/month/route.ts` contains an inline finalize-blocker loop (lines ~84–147) that validates AMEX lines only. It has already drifted from `validateMonthReadyForExport()` in `lib/receipts/month-closing.ts`, which also validates receipt-level fields (date, merchant, amount, category, attendees). Result: `POST /api/receipts/export/month {finalize:true}` can finalize a month that `POST /api/receipts/export/[month]` would block.

- Delete the inline loop. Both finalize paths must call `validateMonthReadyForExport(month)`.
- Extend `validateMonthReadyForExport` to also consult the compliance engine: call `summarizeOpenChecksForMonth` (lib/receipts/compliance.ts); any open check with severity `blocker` blocks finalize; open `warning` checks block only when the `export_block_on_warnings` setting is true (`getComplianceSettings()`). This setting currently exists but is enforced nowhere — that is a bug, not a feature.
- `lib/receipts/blockers.ts` (UI tiles) stays presentation-only but add a code comment cross-referencing month-closing.ts as the enforcement authority.

## A2 — Revision metadata propagation (correctness)

`export/month/route.ts` hardcodes `exportRevision: 1` in the README and passes no revision options to `buildManifestCsv`. When `createExport()` reuses a draft created by `createExportRevision()`, the bundle for revision N ships a README claiming "Revision: 1 (initial)" and a manifest missing `SupersedesExportId`/`CorrectionReason`.

- After `createExport()` returns, load the export row and thread `export_revision`, `supersedes_export_id`, `correction_reason` into both `buildManifestCsv` options and `buildExportReadme`.
- Also deduplicate the double call to `getFinalizedReconciliationForMonth` in that route.

## A3 — Schema migration 0017 (integrity)

Create `db/receipts/0017_export_integrity.sql`, additive only:

- `CREATE UNIQUE INDEX idx_exports_month_revision ON receipt_exports(export_month, export_revision);`
- Partial unique index guaranteeing at most one draft per month: `CREATE UNIQUE INDEX idx_exports_one_draft ON receipt_exports(export_month) WHERE status = 'draft';`
- New table `receipt_export_items (id TEXT PK, export_id TEXT NOT NULL, item_type TEXT NOT NULL CHECK (item_type IN ('receipt','amex_line')), item_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(export_id, item_type, item_id))` with an index on `export_id`. This records exactly which rows shipped in each export — today only the CSV itself knows, which is not queryable for audit.

Do NOT run migrations in a cloud session; note in the PR that the Mac must apply 0017 to live D1 before deploy.

## A4 — Export scope redesign (design decision, implement as specified)

Decision: the export unit is the statement month, not the transaction-date month. Statement lines post over the prior ~6 weeks (see `lib/receipts/statement-window.ts`), so today's CSV (receipts filtered by `transaction_date LIKE 'YYYY-MM%'`) and the AMEX validation set are two different populations — the bundle is not self-consistent.

New CSV composition for month M, built in `lib/receipts/month-closing.ts` (single builder used by route and any preview):

1. One row per AMEX statement line of month M, with a `RowType=amex_line` column, resolved category (`resolveLineCategory`), matched-receipt fields joined when present, and `ReceiptStatus`/`MissingReceiptReason` populated — missing-receipt and no-receipt lines MUST appear in the CSV with their reasons; today they are silently absent, which undermines the audit story.
2. One row per non-AMEX receipt (`payment_path IN ('CASH','DIGITAL')`) with `transaction_date` in month M, `RowType=receipt`. Transaction date is the accounting anchor for these — they have no statement.
3. A receipt matched to a line appears once (on the line row), never twice.
4. `payment_path = 'UNKNOWN'` is a finalize blocker (add to `validateMonthReadyForExport`): an unresolved payment path makes the receipt's export month ambiguous. Today UNKNOWN is never checked and can slide into a bundle.
5. Because cash/digital receipts have no statement cross-check, receipt-level validation is their only gate — the existing receipt checks (date, merchant, amount, category, attendees-where-required) plus the compliance-engine gate from A1 must all apply to them. Include a `PaymentPath` breakdown (AMEX vs CASH vs DIGITAL subtotals) in the summary CSV from A5.

Populate `receipt_export_items` for every row at bundle-build time. Keep `buildMonthlyExportCsv` as the pure CSV serializer; move row assembly into the shared builder.

## A5 — Lifecycle + CSV hardening

- On successful `finalizeExport`, mark every receipt in `receipt_export_items` for that export: `status='exported'`, `exported_month=M`. The column and status value exist and are currently dead. Keep this in the finalize code path with an audit-log entry.
- Split the lock model in `lib/receipts/month-lock.ts` (currently derived solely from AMEX reconciliation status): reconciliation-sealed locks AMEX line edits for the statement month; **export-finalized locks CASH/DIGITAL receipt edits by transaction month**. A cash receipt arriving after its transaction month is finalized must go through the export-revision flow (`?correction=true`) — reject direct edits/inserts into a finalized month with a 409 pointing at the revision endpoint.
- CSV output: prepend UTF-8 BOM and use CRLF line endings (the accountant opens this in Excel on Windows; without BOM, Japanese text renders as mojibake). Guard against formula injection: prefix cells starting with `=`, `+`, `-`, `@` with a single quote in `csvEscape`.
- Add compliance columns to `CSV_HEADERS` and rows: `InvoiceRegistrationNumber`, `QualifiedInvoiceStatus`, `TaxRate`, `TaxAmount`, `SourceType`, `CounterpartyName`. These fields were added in migration 0014 for 電子帳簿保存法/インボイス制度 purposes and are the point of a compliance-forward report; they currently never leave the database.
- Append a `-summary.csv` to the bundle: per-category count/total plus grand total, generated from the same rows, and reference it in the README.

## A6 — Performance + honest UI

- Replace per-receipt `listAttendees` loops (export route, month-closing, page) with one batched month query modeled on `listAmexLineAttendeeNamesByMonth`. Workers subrequest limits make N+1 a real failure mode — size all batching for 3–4 open months, since dashboard/aggregate views multiply per-month query counts.
- `listReceiptRecords({month, limit:1000})` silently truncates; loop with offset until exhausted or raise an explicit error at the cap. At 4 open months the aggregate views make this cap plausible to hit.
- `app/(receipt-system)/receipts/export/page.tsx`: fix `computeDraftStats` double-count (matched AMEX lines and their receipts are both summed today — exclude receipts that are matched to a line); remove the fabricated `sizeBytes: rows*135`; remove hardcoded `cardLast4: "3091"` (read from the line/receipt or omit); remove dead `attendeesLogged: 0` or populate it; delete the `listAttendees` "keep the query path warm" call in `buildManifestSample`.

## A7 — Multi-open-month support (3–4 concurrent open months)

The previous 2-open-months assumption is retired. Audit the module for hidden single-open-month or sequential-close assumptions and fix these specifics:

- **Cross-month match integrity:** overlapping statement windows mean a receipt can now be a candidate for lines in two open months. Add a finalize blocker in `validateMonthReadyForExport`: any receipt matched (`matched_receipt_id`) to statement lines in more than one month blocks both months until resolved. Add a supporting index if the lookup needs one (fold into migration 0017).
- **Out-of-order finalize is allowed** (sealing April while March is open is legitimate), but when finalizing month M with any earlier month still un-finalized, include a non-blocking warning in the finalize response (`warnings: []` field) — a late cash receipt for that earlier month will cost a revision.
- **Draft isolation:** confirm the one-draft-per-month partial index (A3) is the only draft-uniqueness assumption; multiple months may each hold a draft export simultaneously — nothing may assume a single global draft.
- Verify the month switcher / export page queries scale to 4 open months within one request's subrequest budget (combined with A6 batching).

## A8 — Verification

- Unit tests: csvEscape injection guard, BOM/CRLF, buildManifestCsv revision fields, new row-assembly builder (matched line, missing-receipt line with reason, CASH receipt, DIGITAL receipt, UNKNOWN blocked, no double-count), cross-month double-match blocker, out-of-order finalize warning.
- `npx tsc --noEmit` and `npm run build:cf` green.
- Update `docs/architecture.md` (export section) and add ADRs in `docs/adr/` recording: the statement-month export-scope decision (A4), the compliance-gate decision (A1), the split lock model for cash receipts (A5), and the 3–4 concurrent open months operating assumption (A7).
- Summarize in the PR: what changed per activity, what the Mac must do (apply 0017, `cf:dev` smoke of draft→finalize→revision flow, `scripts/check-deployment.sh` after deploy).
