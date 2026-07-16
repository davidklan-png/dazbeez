# Dazbeez

AI, Automation & Data Solutions website built with Next.js 16.2.3.

> A consulting site with service pages, direct contact intake, an internal admin CRM, a receipts reconciliation module, and NFC-enabled micro-pages.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Next.js 16.2.3](https://nextjs.org) (App Router) |
| Styling | [Tailwind CSS](https://tailwindcss.com) |
| Fonts | Inter (Google Fonts) |
| Runtime | Cloudflare Workers via [OpenNext Cloudflare](https://opennext.js.org/cloudflare) |
| Auth | [Clerk](https://clerk.com) for `/admin`, `/receipts`, `/api/receipts` (see [docs/runbooks/clerk-auth-migration.md](docs/runbooks/clerk-auth-migration.md)) |
| Persistence | Cloudflare D1 — `DB` (contact), `CRM_DB` (networking + CRM), `RECEIPTS_DB` (receipts) |
| Object storage | Cloudflare R2 — `CRM_IMAGES`, `RECEIPTS_BUCKET`, `RECEIPTS_ARCHIVE_BUCKET` |
| Async processing | Cloudflare Queue (`RECEIPTS_QUEUE`) drained by an off-platform Mac MLX consumer (ADR 0001) |
| Optional local reference | Docker Compose + Dockerfile |
| Optional LLM | [Ollama](https://ollama.com) |

## Production Architecture

The system is several cooperating Cloudflare units (detail in
[docs/architecture.md](docs/architecture.md)):

- **Main site** (`dazbeez` Worker, repo root) — marketing site, `/contact`
  intake, `/admin` CRM, and the **receipts module** (`/receipts`). Binds three
  D1 databases (`DB`, `CRM_DB`, `RECEIPTS_DB`), three R2 buckets (`CRM_IMAGES`,
  `RECEIPTS_BUCKET`, `RECEIPTS_ARCHIVE_BUCKET`), a Queue producer
  (`RECEIPTS_QUEUE`), and Workers AI.
- **Networking card** (`networking-card/`, Cloudflare Pages) — NFC/QR contact
  capture; shares `CRM_DB`.
- **Email reply capture** (`workers/email-reply-capture/`, a separate Worker on
  Cloudflare Email Routing) — ingests inbound email replies into `CRM_DB`.
- **Receipts extraction consumer** (`scripts/receipts-consumer/`, Mac M4) —
  off-platform HTTP pull consumer that drains `RECEIPTS_QUEUE` and runs MLX VLM
  extraction ([ADR 0001](docs/adr/0001-receipt-extraction-runtime.md)).

Authentication: `/admin`, `/receipts`, and `/api/receipts` are gated by **Clerk**
(Phase 2, PR #59; `middleware.ts` + `lib/receipts/auth.ts`); `/api/mobile/*`
uses a device-bearer scheme. (The earlier HTTP-Basic auth for `/admin` has been
replaced.)

Key runtime integrations:

- `/api/contact` persists submissions into the `DB` D1 database.
- `/admin/batches` runs business-card batch ingestion against the shared
  `CRM_DB`; Cloudflare AI does card detection and OCR field extraction.
- Receipts capture is async store-and-forward: the Worker stores the file in
  `RECEIPTS_BUCKET`, writes `RECEIPTS_DB`, and enqueues an extraction job; the
  Mac consumer pulls, extracts, and writes results back. See the ADRs in
  [docs/adr/](docs/adr/) and [docs/receipt-module.md](docs/receipt-module.md).

## Local Development

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and fill in local values.
3. Start the app with `npm run dev`.
4. Open `http://localhost:4488`.

Use `npm run cf:dev` to preview the app in the Cloudflare Workers runtime after the D1 binding is configured.

## Cloudflare Deployment

Core commands:

```bash
npm run build:cf
npm run deploy
```

Useful helpers:

```bash
# Preview in the Workers runtime locally
npm run cf:dev

# Regenerate Cloudflare binding types
npm run cf-typegen
```

Production configuration lives in `wrangler.jsonc`. Contact submission schema lives in `db/schema.sql`.

## Business Card CRM

The internal admin now includes a bespoke CRM and paper business-card batch ingestion flow under `/admin`:

- `/admin/batches` — upload a composite image, detect cards, crop them client-side, store the batch, and extract card fields
- `/admin/review` — low-confidence OCR and dedupe tasks
- `/admin/contacts` and `/admin/contacts/[id]` — unified contacts across NFC, public form, and paper-card sources
- `/admin/companies` — linked company records
- `/admin/drafts` — personalized follow-up drafts (draft-only, never auto-sent)
- `/admin/settings` — editable Dazbeez profile, thresholds, and integration strategy JSON

### Shared CRM Database

The main site now reads and writes the `networking-card` D1 database through the `CRM_DB` binding. Before using the new admin CRM screens, run the networking-card migrations so the shared schema includes the CRM tables:

```bash
cd networking-card
npm run db:migrate:local

# for production
npm run db:migrate:remote
```

The new migration `networking-card/migrations/0007_bespoke_crm.sql` extends the existing NFC lead-capture schema with:

- contact batches and stored card images
- batch card review records
- companies
- enrichment runs and evidence-backed facts
- synergy analyses
- email drafts
- review tasks
- admin settings
- audit logs

### Verification

Recommended verification sequence for this feature:

```bash
npm test
npm run lint
npm run build:cf
```

Then open `/admin/batches`, upload a composite image, review the extracted cards, and run the CRM upsert + draft generation step.

## Docker Reference

`Dockerfile` and `docker-compose.yml` remain in the repo for local/reference workflows only.

Production no longer runs through Docker, Nginx, Caddy, or Cloudflare Tunnel.

Optional local extras:

```bash
# Local reverse proxy reference
docker-compose --profile proxy up -d

# Optional Ollama sidecar
docker-compose --profile llm up -d
```

## Routes

| Route | Purpose |
|-------|---------|
| `/` | Landing page |
| `/about` | About David Klan |
| `/services` | Services list |
| `/services/[slug]` | Service detail (ai, automation, data, governance, pm) |
| `/contact` | Contact form |
| `/admin` | Internal CRM + business-card ingestion (Clerk-authed) |
| `/receipts` | Receipts reconciliation dashboard (Clerk-authed) |
| `/receipts/capture` | Receipt capture (desktop + mobile web) |
| `/receipts/review` | Receipt review queue |
| `/receipts/reconcile` | AMEX statement reconciliation |
| `/receipts/export` | Monthly export + compliance/finalize |
| `/business-card` | NFC card explainer |
| `/nfc` | NFC micro-page (widget-style) |
| `/privacy-policy` | Privacy policy |
| `/terms-of-service` | Terms of service |
