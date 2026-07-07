# Architecture

## Overview

Dazbeez is a Next.js 16.2.3 consulting website deployed on Cloudflare Workers via OpenNext. It consists of two independent deployable units:

| Unit | Purpose | Runtime |
|------|---------|---------|
| **Main site** (`/`) | Marketing, inquiry, contact, admin | Cloudflare Workers + D1 |
| **Networking card** (`networking-card/`) | NFC/QR contact capture | Cloudflare Pages + Functions |

---

## Traffic Flow (Production)

```
Browser → Cloudflare CDN (dazbeez.com)
            ↓
        Cloudflare Worker (`dazbeez`)
            ↓
      OpenNext server bundle on Workers
            ↓
      Cloudflare D1 (`dazbeez-submissions`) for `/api/contact`
```

`www.dazbeez.com` should be attached as a Worker custom domain alongside `dazbeez.com`.

---

## Main Site Runtime

Core config files:

- `wrangler.jsonc` — Worker entry, D1 binding, assets binding, self-reference binding
- `open-next.config.ts` — OpenNext adapter config
- `next.config.ts` — OpenNext dev init, redirects, headers, unoptimized images
- `db/schema.sql` — D1 schema for contact submissions
- `lib/contact-submissions.ts` — D1 insert path using `getCloudflareContext()`

Deployment commands:

```bash
npm run build:cf
npm run deploy
```

Local Worker preview:

```bash
npm run cf:dev
```

### D1 Schema

`contact_submissions`
- `id`
- `first_name`
- `last_name`
- `email`
- `company`
- `phone_number`
- `service`
- `message`
- `source`
- `submitted_at`

### Environment / Secrets

Runtime secrets configured in Cloudflare:
- `ADMIN_PAGE_USERNAME`
- `ADMIN_PAGE_PASSWORD`
- `NFC_ADMIN_API_URL`
- `NFC_ADMIN_API_KEY`

### `ollama` (profile: `llm`)
- Image: `ollama/ollama:latest`
- Port: `11434:11434`
- Reserved for future chatbot enhancement — local-only, not active in production

---

## Next.js App Structure (App Router)

```
app/
├── layout.tsx              # Root layout: Inter font, SiteNavigation, Footer, OG metadata
├── page.tsx                # Home — hero, services grid, CTA
├── globals.css             # Tailwind base + custom globals
├── opengraph-image.tsx     # OG image (1200×630)
├── robots.ts               # robots.txt generation
├── sitemap.ts              # sitemap.xml generation
├── services/
│   ├── page.tsx            # Services listing
│   └── [slug]/page.tsx     # Service detail (SSG via generateStaticParams)
├── contact/page.tsx        # Contact form (client component)
├── nfc/page.tsx            # NFC landing widget (client component)
└── admin/page.tsx          # Internal dashboard (server component, noindex)

components/
├── site-navigation.tsx     # Sticky nav with mobile menu (client component)
└── admin/
    └── admin-dashboard.tsx # Dashboard presentation component

lib/
├── admin-dashboard-data.ts # Typed seed data for admin dashboard
└── contact-submissions.ts  # D1-backed submission persistence
```

**Rendering pattern:**
- Server components by default
- `"use client"` only where interactivity is required (inquiry, contact, nfc, site-navigation)
- Admin page: server component passing static data as props to a pure presentation component

---

## Networking Card (Cloudflare Pages)

Subdirectory: `networking-card/`  
Runtime: Cloudflare Pages Functions (Workers runtime)  
Database: Cloudflare D1 (SQLite at edge)

### Routes

| Route | Handler |
|-------|---------|
| `GET /hi/:token` | `functions/hi/[token].ts` |
| `GET /auth/google/callback` | `functions/auth/google/callback.ts` |
| `GET /auth/linkedin/callback` | `functions/auth/linkedin/callback.ts` |
| `POST /submit` | `functions/submit.ts` |
| `GET /thanks` | `functions/thanks.ts` |
| `GET /vcard/:contact_id` | `functions/vcard/[contact_id].ts` |

### External Services

| Service | Purpose | Binding/Secret |
|---------|---------|----------------|
| Cloudflare D1 | Contact/tap storage | `DB` binding |
| Resend | Acknowledgment emails | `RESEND_API_KEY` |
| Discord Webhook | Real-time notifications | `DISCORD_WEBHOOK_URL` |
| Google OAuth 2.0 | Sign-in | `GOOGLE_CLIENT_ID/SECRET` |
| LinkedIn OAuth 2.0 | Sign-in | `LINKEDIN_CLIENT_ID/SECRET` |

### Database Schema

```sql
cards     (token PK, label, created_at)
contacts  (id, token FK, name, email, source, linkedin_url, company, cf_country, cf_city, user_agent, created_at)
taps      (id, token FK, cf_country, cf_city, user_agent, created_at)
```

---

## Receipts Module — Export Pipeline

The receipts module (`app/(receipt-system)/receipts/`, `app/api/receipts/`, `lib/receipts/`) is the largest subsystem in the repo. What follows is the export-pipeline slice; the async capture/extract runtime is documented in ADR 0001.

### Scope: the export unit is the statement month

A monthly export ships **one row per AMEX statement line of month M**, plus **one row per CASH/DIGITAL receipt whose `transaction_date` falls in month M**. AMEX lines post over a ~6-week window that lags the statement label (see `lib/receipts/statement-window.ts`); filtering receipts by `transaction_date LIKE 'YYYY-MM%'` produces a different population than the AMEX validation set, so the bundle assembles both in one place to stay self-consistent.

- Single row-assembly authority: `buildExportBundle(month)` in `lib/receipts/month-closing.ts`. Consumed by both the export route (CSV/manifest upload) and the finalize validator — the operator's preview is bit-identical to what ships.
- A receipt matched to a line appears once (on the line row), never twice.
- `payment_path = 'UNKNOWN'` receipts are intentionally excluded from the bundle; their export month is ambiguous. The validator blocks finalize when any are present.
- Per-bundle audit trail in `receipt_export_items` records exactly which receipts and lines shipped — queryable from D1 instead of forcing an R2 fetch.

ADR: `docs/adr/0002-statement-month-export-scope.md`.

### Single enforcement authority

`validateMonthReadyForExport(month, prebuiltBundle?, preloadedReconciliation?)` in `lib/receipts/month-closing.ts` is the **only** gate. Both finalize paths (`POST /api/receipts/export/month {finalize:true}` and `POST /api/receipts/export/[month]`) call it; UI tiles in `lib/receipts/blockers.ts` are presentation-only.

The validator runs six checks, in order:

1. Statement-sealed gate — a finalized reconciliation must exist for the month.
2. UNKNOWN `payment_path` gate — any UNKNOWN receipt with `transaction_date` in M blocks finalize.
3. Receipt-level checks (date, merchant, amount, category, attendees-where-required) on every CASH/DIGITAL receipt in the bundle.
4. AMEX-line checks via `validateAmexLinesForSignoff`.
5. Compliance-engine gate (`summarizeOpenChecksForMonth`): open `blocker` checks always block; open `warning` checks block only when `receipt_settings.export_block_on_warnings` is true.
6. Cross-month match integrity — a receipt matched to AMEX lines in two statement months blocks both months.

ADR: `docs/adr/0003-compliance-engine-finalize-gate.md`.

### Split lock model

Two independent locks govern month-end state:

| Lock | Scope | Blocks |
|------|-------|--------|
| Reconciliation-sealed | Statement month | AMEX line edits + matched-receipt edits |
| Export-finalized | Transaction month | CASH/DIGITAL receipt inserts/edits anchored by `transaction_date` |

A cash receipt arriving after its transaction month has shipped must go through the export-revision flow (`POST /api/receipts/export/<month>?correction=true`) — direct edits/inserts into a finalized month are rejected with a 409 pointing at the revision endpoint. The two locks never overlap: AMEX-path receipts are governed by reconciliation-sealed via their statement line, CASH/DIGITAL by export-finalized via their `transaction_date`.

Helpers in `lib/receipts/month-lock.ts`: `ExportFinalizedError` (typed, thrown by the authority), `assertTransactionMonthEditable(month)`, `transactionMonthOf(date)`.

ADR: `docs/adr/0004-split-lock-model-cash-receipts.md`.

### CSV hardening (accountant-facing)

The accountant opens the monthly CSV in **Excel on Windows**. Three hardening rules apply:

- **UTF-8 BOM** so Excel detects encoding and renders Japanese merchants instead of mojibake.
- **CRLF** line endings (Excel-friendlier).
- **Formula injection guard** — cells starting with `=`, `+`, `-`, `@` are prefixed with a single quote so Excel doesn't evaluate them as formulas on open.

The route applies all three via `bomPrefixedCrlf(csvText)` before hashing and upload; the SHA-256 in the manifest matches the bytes in R2 exactly. Tests exercise the pure CSV form; the BOM/CRLF wrapper is a route-layer concern.

Each bundle ships four artifacts into the `RECEIPTS_ARCHIVE_BUCKET`:

| Key | Contents |
|-----|----------|
| `exports/<M>/<id>-receipts.csv` | The main CSV (BOM+CRLF) |
| `exports/<M>/<id>-manifest.csv` | Metadata + per-file SHA-256 table |
| `exports/<M>/<id>-summary.csv` | Per-category and per-PaymentPath totals |
| `exports/<M>/<id>-README.txt` | Disclaimers (EN/JA), revision context, SHA-256 chain |

Compliance columns on the main CSV (電子帳簿保存法 / インボイス制度): `InvoiceRegistrationNumber`, `QualifiedInvoiceStatus`, `TaxRate`, `TaxAmount`, `SourceType`, `CounterpartyName`.

### Operating assumption: 3–4 concurrent open months

Statement windows overlap, so a receipt may be a candidate for lines in two open months. The validator handles this two ways:

- **Blocker:** a receipt matched to AMEX lines in more than one month blocks finalize in both months until disambiguated.
- **Warning:** finalizing month M while an earlier month is still open returns a non-blocking `warnings: string[]` in the finalize response. A late cash receipt for that earlier month will cost a revision once it lands.

ADR: `docs/adr/0005-multi-open-month-assumption.md`.

### Lifecycle: `receipt_records.status`

```
captured → needs_review → reviewed → reconciled → exported → archived
   (ADR 0001 extraction pipeline)        (finalizeExport promotes to 'exported')
```

`finalizeExport` marks every receipt in `receipt_export_items` for the finalized export: `status='exported'`, `exported_month=M`. Once exported, direct edits are rejected with a 409 pointing at the revision endpoint; the operator must open a correction. `'archived'` is terminal and is not unwound by a re-finalize.

---

## Local Reference Runtime

`Dockerfile` and `docker-compose.yml` are retained only as local/reference artifacts.

Current local ports:
- `4488` — `npm run dev`
- `8787` — `npm run cf:dev`
- `8788` — `networking-card` local Pages dev
- `11434` — optional local Ollama profile

---

## Verification

1. `npm run build:cf`
2. `npm run cf:dev`
3. `bash scripts/check-deployment.sh http://localhost:8787`
4. `bash scripts/check-deployment.sh https://dazbeez.com`
