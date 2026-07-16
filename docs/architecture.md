# Architecture

## Overview

Dazbeez is a Next.js 16.2.3 consulting website deployed on Cloudflare Workers
via OpenNext. It is a small system of cooperating Cloudflare units plus one
off-platform processing component:

| Unit | Location | Purpose | Runtime |
|------|----------|---------|---------|
| **Main site** | `/` (repo root) | Marketing, contact intake, admin CRM, and the **receipts module** | Cloudflare Worker (`dazbeez`) + D1 + R2 + Queue + Workers AI |
| **Networking card** | `networking-card/` | NFC/QR contact capture → vCard / GIS / Discord / email | Cloudflare Pages + Functions + D1 |
| **Email reply capture** | `workers/email-reply-capture/` | Inbound email-reply ingestion into the CRM | Cloudflare Worker (Email Routing) + D1 — **own `wrangler.jsonc` present; live deployment not verified from this tree** |
| **Receipts extraction consumer** | `scripts/receipts-consumer/` (Mac M4) | Drains the extraction queue and runs MLX VLM extraction | Off-platform HTTP pull consumer (ADR 0001) |

The units share two D1 databases: `CRM_DB` (networking card + admin CRM + email
replies) and `RECEIPTS_DB` (receipts); the main site additionally owns the
contact-submission `DB`. R2 holds `CRM_IMAGES`, `RECEIPTS_BUCKET`, and
`RECEIPTS_ARCHIVE_BUCKET`. Authentication on the main site is **Clerk** for
`/admin`, `/receipts`, and `/api/receipts` (Phase 2 shipped, PR #59;
`middleware.ts` + `lib/receipts/auth.ts`); `/api/mobile/*` uses a separate
device-bearer scheme. Receipts capture is async store-and-forward: the Worker
enqueues onto `RECEIPTS_QUEUE` and the Mac consumer pulls and extracts
(ADR 0001). The detailed receipts export pipeline is documented later in this
file ([Receipts Module — Export Pipeline](#receipts-module--export-pipeline)).

---

## Traffic Flow (Production)

All public traffic reaches the main Worker (`dazbeez`) via the Cloudflare CDN;
`www.dazbeez.com` is a Worker custom domain alongside `dazbeez.com`. Within the
Worker, request paths fan out to different bindings:

```text
Browser ─▶ Cloudflare CDN (dazbeez.com) ─▶ Worker `dazbeez` (OpenNext)
                                              │
  /api/contact ─── dual-write ──┬─▶ D1 `DB`        (contact_submissions)
                                └─▶ D1 `CRM_DB`    (CRM upsert via lib/crm.ts)
  /admin ─── Clerk-authed ──────▶ D1 `CRM_DB` + R2 `CRM_IMAGES` (card OCR via Workers AI)
  /receipts, /api/receipts ─────▶ D1 `RECEIPTS_DB` + R2 `RECEIPTS_BUCKET`
  /api/receipts/upload ─────────▶ R2 put + D1 insert + Queue send `RECEIPTS_QUEUE`
                                                                     │
  Mac MLX consumer (scripts/receipts-consumer/) ◀── HTTP pull ──────┘
       └─▶ POST /api/receipts/[id]/extract (processor-key) ─▶ D1 update
  finalize / export ────────────▶ R2 `RECEIPTS_ARCHIVE_BUCKET` (5-artifact bundle)
```

`/api/mobile/*` uses a device-bearer scheme, not Clerk. The networking-card
Pages app and the email-reply-capture Worker are separate deployable units (see
[Overview](#overview)) and share `CRM_DB`; the email-reply Worker's live
deployment is not verified from this tree.

---

## Main Site Runtime

Core config files:

- `wrangler.jsonc` — Worker entry + bindings: D1 (`DB`, `CRM_DB`, `RECEIPTS_DB`), R2 (`CRM_IMAGES`, `RECEIPTS_BUCKET`, `RECEIPTS_ARCHIVE_BUCKET`), Queue producer (`RECEIPTS_QUEUE`), Workers AI (`AI`), self-reference service; checked-in `vars` include the Clerk publishable key and the accountant/notify-from email addresses. Routes: `dazbeez.com/*`, `www.dazbeez.com/*`.
- `middleware.ts` — Clerk middleware; the active auth gate for `/admin`, `/receipts`, `/api/receipts`. `/api/mobile/*` is intentionally not matched (device-bearer scheme).
- `open-next.config.ts` — OpenNext adapter config
- `next.config.ts` — OpenNext dev init, redirects, headers, unoptimized images
- `db/schema.sql` — D1 schema for contact submissions (`DB`)
- `lib/contact-submissions.ts` — `DB` insert path; `app/api/contact/route.ts` additionally upserts the same submission into `CRM_DB` via `lib/crm.ts`

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

Current runtime configuration (verified from `wrangler.jsonc` + code):

- **Clerk** — `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (checked-in var) + `CLERK_SECRET_KEY` (wrangler secret). The active auth gate (`middleware.ts`, `lib/receipts/auth.ts`).
- **Receipts extraction processor** — `RECEIPTS_PROCESSOR_KEY` (wrangler secret); authenticates the Mac consumer's queue pulls and `POST /api/receipts/[id]/extract` (ADR 0001).
- **Resend** — `RESEND_API_KEY` (wrangler secret); sends the finalize notification email. `NOTIFY_FROM_ADDRESS` and `ACCOUNTANT_EMAIL` are checked-in vars.
- **Workers AI** — `AI` binding (remote); business-card detection and OCR field extraction in admin ingestion.

Legacy / not active for human login — retained in `lib/receipts/auth.ts` as dead or local-only code (pending Phase 4 removal):

- `CF_ACCESS_TEAM` / `CF_ACCESS_AUD` — Cloudflare Access JWT verification. **Legacy/dead** (no live callers; superseded by Clerk).
- `RECEIPTS_AUTH_USERNAME` / `RECEIPTS_AUTH_PASSWORD` — HTTP Basic. **Local-dev only** (only advertised/accepted when set, e.g. in `.dev.vars`).

### `ollama` (profile: `llm`)
- Image: `ollama/ollama:latest`
- Port: `11434:11434`
- Reserved for future chatbot enhancement — local-only, not active in production

---

## App Structure (conceptual module map)

The literal file tree changes often; this is the stable conceptual map of the
Next.js App Router app.

- **Public marketing** — home, `/services` + `/services/[slug]` (SSG via `generateStaticParams`), `/contact`, `/nfc`, `/business-card`, plus legal pages. Mostly server components; the contact form and NFC widget are client components.
- **Admin CRM** (`app/admin/*`, `app/admin/api/*`) — business-card batch ingestion, contacts/companies, review tasks, drafts, settings. Live D1-backed CRM (`CRM_DB`), Clerk-authed (not the former static seed-data dashboard).
- **Receipts module** (`app/(receipt-system)/receipts/*` route group + `app/api/receipts/*`) — capture, review, reconcile, amex, export, settings; domain logic in `lib/receipts/*`.
- **API routes** — `/api/contact` (dual-writes `DB` + `CRM_DB`), `/api/receipts/*` (Clerk), `/api/mobile/*` (device-bearer; iOS capture + business-card upload), `/api/vcard`.
- **Shared libs** — `lib/receipts/*` (receipts domain + the client-safe `upload-policy.ts` capture policy), `lib/crm*` (CRM domain), `lib/cloudflare-runtime.ts` (binding accessors).

**Rendering pattern:** server components by default; `"use client"` only where
interactivity is required (forms, capture, navigation, animations).

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

The validator runs these gates in order (`validateMonthReadyForExportCore` in
`lib/receipts/month-closing.ts`):

1. **Statement-sealed** — a finalized reconciliation must exist for the month.
2. **UNKNOWN `payment_path`** — any UNKNOWN receipt with `transaction_date` in M blocks finalize.
2.5. **Unreviewed** — any in-month `needs_review` receipt blocks finalize (pending-processing receipts are excluded, matching the review tile).
3. **Receipt-level** — date, merchant, amount, expense category, and attendees-where-required on every CASH/DIGITAL receipt in the bundle.
4. **AMEX-line checks** via `validateAmexLinesForSignoff`.
5. **Compliance-engine** (`summarizeOpenChecksForMonth`): open `blocker` checks always block; open `warning` checks block only when `receipt_settings.export_block_on_warnings` is true.
6. **Cross-month match integrity** — a receipt matched to AMEX lines in two statement months blocks both months.
7. **Proofs presence** — every shipped receipt must have a proof file (original or `proof_copy`) on record; a receipt with zero `receipt_files` rows has nothing to include in the proofs ZIP.

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

Each bundle ships five artifacts into the `RECEIPTS_ARCHIVE_BUCKET`:

| Key | Contents |
|-----|----------|
| `exports/<M>/<id>-receipts.csv` | The main CSV (BOM+CRLF) |
| `exports/<M>/<id>-manifest.csv` | Metadata + per-file SHA-256 table |
| `exports/<M>/<id>-summary.csv` | 集計 — per-category and per-PaymentPath totals |
| `exports/<M>/<id>-proofs.zip` | Proofs bundle — one proof image per shipped receipt (with the 集計 summary and a transition notice embedded) |
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
