# Dazbeez Receipt Module PRD

## Decision

Build the receipt reporting system as a separate protected module inside the existing `dazbeez` Next.js application, available at `/receipts`, with its own data bindings, schema, components, API routes, documentation, and tests.

The receipt module must not reuse the CRM database, networking-card database tables, contact-submission tables, `/admin` CRM layout, or public marketing navigation.

## Product Goal

Replace the monthly paper-receipt composite-scan workflow with a mobile-first, one-receipt-per-record workflow that supports AMEX reconciliation, CASH expense capture, meeting/entertainment attendee tracking, monthly accountant exports, and immutable receipt archives.

## Non-Goals

- Do not modify the public homepage, service pages, or networking-card application behavior.
- Do not merge receipt data into the CRM or contact-submission database.
- Do not require MoneyForward/freee as the source of truth.
- Do not process the FY2020-FY2026 legacy receipt archive before launching the new workflow.
- Do not build a live camera scanner in the first release; use mobile file input capture first.

## Route Boundary

Protected application routes:

- `/receipts` - dashboard
- `/receipts/capture` - iPhone-friendly receipt capture form
- `/receipts/review` - review and correction queue
- `/receipts/amex` - AMEX statement import and reconciliation
- `/receipts/cash` - cash expense list
- `/receipts/attendees` - attendee review for meeting/entertainment expenses
- `/receipts/export` - monthly accountant export and archive workflow
- `/receipts/settings` - category and accountant-export settings

Protected API routes:

- `POST /api/receipts/upload`
- `GET /api/receipts`
- `GET /api/receipts/[id]`
- `PATCH /api/receipts/[id]`
- `GET /api/receipts/[id]/file`
- `POST /api/receipts/[id]/extract`
- `POST /api/receipts/amex/import`
- `POST /api/receipts/reconcile`
- `POST /api/receipts/export/month`
- `GET /api/receipts/export/[month]`

## Repository Layout

```text
app/
  (receipt-system)/
    receipts/
      layout.tsx
      page.tsx
      capture/page.tsx
      review/page.tsx
      amex/page.tsx
      cash/page.tsx
      attendees/page.tsx
      export/page.tsx
      settings/page.tsx
  api/
    receipts/
      upload/route.ts
      route.ts
      [id]/route.ts
      [id]/file/route.ts
      [id]/extract/route.ts
      amex/import/route.ts
      reconcile/route.ts
      export/month/route.ts
      export/[month]/route.ts

components/
  receipts/
    receipt-shell.tsx
    receipt-capture-form.tsx
    receipt-review-form.tsx
    amex-import-form.tsx
    reconciliation-table.tsx
    attendee-editor.tsx
    monthly-export-panel.tsx

lib/
  receipts/
    auth.ts
    db.ts
    storage.ts
    validation.ts
    extraction.ts
    reconciliation.ts
    export.ts
    audit.ts
    types.ts

db/
  receipts/
    0001_init.sql
    0002_exports.sql

docs/
  receipt-module.md

tests/
  receipts/
    validation.test.ts
    reconciliation.test.ts
    export.test.ts
```

## Cloudflare Bindings

Add separate bindings in `wrangler.jsonc`:

```jsonc
{
  "d1_databases": [
    {
      "binding": "RECEIPTS_DB",
      "database_name": "dazbeez-receipts",
      "database_id": "<created-by-wrangler>"
    }
  ],
  "r2_buckets": [
    {
      "binding": "RECEIPTS_BUCKET",
      "bucket_name": "dazbeez-receipts"
    },
    {
      "binding": "RECEIPTS_ARCHIVE_BUCKET",
      "bucket_name": "dazbeez-receipts-archive"
    }
  ]
}
```

Use `RECEIPTS_DB` for metadata and workflow state. Use `RECEIPTS_BUCKET` for working receipt originals and derived files. Use `RECEIPTS_ARCHIVE_BUCKET` for monthly frozen accountant bundles and hash manifests.

## Authentication

Preferred production protection:

- Cloudflare Access application protecting:
  - `https://dazbeez.com/receipts*`
  - `https://dazbeez.com/api/receipts*`
- Allow only the two Dazbeez users.
- Add a separate service token for any local Mac export/sync agent.
- Validate the `Cf-Access-Jwt-Assertion` header inside the receipt module before serving sensitive pages or APIs.

Local development fallback:

- Separate receipt-specific basic auth variables may be used only for local development if Cloudflare Access is not available.

## Capture Requirements

The iPhone capture page must support:

- One receipt per submission.
- Mobile file input with `accept="image/*"` and `capture="environment"`.
- Payment path: AMEX, CASH, DIGITAL.
- Expense type: meeting-no-alcohol, entertainment-alcohol, transportation, books, research, insurance, misc, and configurable future categories.
- Transaction date.
- Amount and currency.
- Merchant.
- Business purpose.
- Attendees required for meeting and entertainment categories.
- Notes.

The original uploaded file must be stored unchanged in R2. Any cleaned image, extracted JSON, generated PDF, CSV, or spreadsheet is a derivative artifact and must point back to the original receipt record.

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS receipt_records (
  id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  captured_by TEXT NOT NULL,
  payment_path TEXT NOT NULL CHECK (payment_path IN ('AMEX','CASH','DIGITAL')),
  expense_type TEXT NOT NULL,
  transaction_date TEXT,
  merchant TEXT,
  amount_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'JPY',
  tax_amount_minor INTEGER,
  business_purpose TEXT,
  alcohol_present INTEGER NOT NULL DEFAULT 0,
  attendees_required INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'captured',
  original_r2_key TEXT NOT NULL,
  original_sha256 TEXT NOT NULL,
  original_content_type TEXT NOT NULL,
  original_size_bytes INTEGER NOT NULL,
  processed_r2_key TEXT,
  extraction_json TEXT,
  legacy INTEGER NOT NULL DEFAULT 0,
  exported_month TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_attendees (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipt_records(id) ON DELETE CASCADE,
  attendee_name TEXT NOT NULL,
  company TEXT,
  relationship TEXT,
  is_dazbeez_employee INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS amex_statement_lines (
  id TEXT PRIMARY KEY,
  statement_month TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  posting_date TEXT,
  merchant TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'JPY',
  amex_reference TEXT,
  matched_receipt_id TEXT REFERENCES receipt_records(id),
  match_status TEXT NOT NULL DEFAULT 'unmatched',
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_exports (
  id TEXT PRIMARY KEY,
  export_month TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  archive_r2_key TEXT,
  manifest_r2_key TEXT,
  archive_sha256 TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS receipt_audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_month ON receipt_records(transaction_date);
CREATE INDEX IF NOT EXISTS idx_receipts_payment ON receipt_records(payment_path);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipt_records(status);
CREATE INDEX IF NOT EXISTS idx_amex_month ON amex_statement_lines(statement_month);
CREATE INDEX IF NOT EXISTS idx_amex_match_status ON amex_statement_lines(match_status);
```

## AMEX Workflow

1. Import the monthly AMEX CSV.
2. Insert statement rows into `amex_statement_lines`.
3. Auto-match candidate receipts by date window, merchant similarity, and exact amount.
4. Human review resolves unmatched or ambiguous lines.
5. Missing receipt rows remain visible until resolved or marked as no-receipt.

AMEX is statement-first; receipts are evidence attached to statement rows.

## CASH Workflow

1. Receipt upload creates the cash expense record immediately.
2. Monthly review validates amount, category, business purpose, and attendee requirements.
3. Export totals CASH separately for reimbursement/accountant treatment.

CASH is receipt-first because there is no external card statement control source.

## Extraction Workflow

Initial release:

- Manual capture form plus optional manual correction.
- Store extracted fields as structured columns and raw extraction JSON.

Second release:

- Add pluggable extraction provider in `lib/receipts/extraction.ts`.
- Provider returns strict JSON only.
- Human review remains required before export.

## Monthly Export

Monthly export creates:

```text
YYYY-MM_Dazbeez_Expense_Report.csv
YYYY-MM_AMEX_statement.csv
YYYY-MM_cash_expenses.csv
YYYY-MM_attendees.csv
receipts/AMEX/*
receipts/CASH/*
receipts/DIGITAL/*
manifest_sha256.csv
README_for_accountant.txt
```

The final export bundle is uploaded to `RECEIPTS_ARCHIVE_BUCKET` and locked using R2 bucket lock rules.

## Security Requirements

- No public links to `/receipts`.
- `robots: noindex` on all receipt pages.
- `X-Robots-Tag: noindex, nofollow` on `/receipts/:path*` and `/api/receipts/:path*`.
- Auth check in every receipt page layout and API route.
- Strict file type and size validation.
- Store originals with content hash.
- Never overwrite original receipt objects.
- All edits create audit-log entries.
- Export finalization is append-only from an audit perspective.

## Implementation Milestones

### Milestone 1: Isolated shell

- Add `docs/receipt-module.md`.
- Add route group and receipt layout.
- Add protected `/receipts` dashboard.
- Add noindex headers for receipt routes.
- Add separate `lib/receipts` namespace.

### Milestone 2: Storage and database

- Create `dazbeez-receipts` D1 database.
- Create `dazbeez-receipts` R2 bucket.
- Add `RECEIPTS_DB` and `RECEIPTS_BUCKET` bindings.
- Add schema migration.
- Add upload API.

### Milestone 3: Capture and review

- Add mobile capture form.
- Store original image in R2.
- Create metadata row in D1.
- Add receipt review screen.
- Enforce attendees for meeting/entertainment.

### Milestone 4: AMEX import and reconciliation

- Add CSV import.
- Add matching logic.
- Add reconciliation review UI.

### Milestone 5: Monthly export and archive

- Generate CSV/accountant export bundle.
- Generate hash manifest.
- Upload frozen bundle to archive bucket.
- Apply R2 bucket lock retention.

### Milestone 6: Structured extraction

- Add LLM/OCR provider abstraction.
- Require human confirmation before data becomes exportable.

## Acceptance Criteria

- Public homepage and networking-card app continue to work without behavioral changes.
- Receipt data uses `RECEIPTS_DB`, not `DB` or `CRM_DB`.
- Receipt files use R2, not D1 blobs.
- `/receipts` and `/api/receipts` are protected and noindex.
- iPhones can capture one receipt at a time from the web app.
- Meeting and entertainment receipts cannot be exported without attendee rows.
- AMEX statement rows can be imported and reconciled.
- CASH expenses can be reviewed separately.
- A monthly accountant bundle can be generated with a hash manifest.
- A finalized monthly bundle can be locked in R2.
