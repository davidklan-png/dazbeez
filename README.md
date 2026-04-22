# Dazbeez

AI, Automation & Data Solutions website built with Next.js 16.2.3.

> A consulting site with service pages, direct contact intake, an internal admin page, and NFC-enabled micro-pages.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Next.js 16.2.3](https://nextjs.org) (App Router) |
| Styling | [Tailwind CSS](https://tailwindcss.com) |
| Fonts | Inter (Google Fonts) |
| Runtime | Cloudflare Workers via [OpenNext Cloudflare](https://opennext.js.org/cloudflare) |
| Persistence | Cloudflare D1 for contact submissions |
| Optional local reference | Docker Compose + Dockerfile |
| Optional LLM | [Ollama](https://ollama.com) |

## Production Architecture

```text
dazbeez.com → Cloudflare CDN → Cloudflare Worker → Next.js app
                                            └→ D1 (contact submissions)
```

Key runtime integrations:

- `/api/contact` persists submissions into a D1 database.
- `/admin` uses HTTP Basic auth backed by runtime environment variables.
- NFC dashboard data is fetched from the external NFC admin API.
- `/admin/batches` runs business-card batch ingestion against the shared CRM D1.
- The main site now binds both the local `DB` submission database and the shared `CRM_DB` used by the networking-card flow.
- Cloudflare AI is used for card detection and OCR-style field extraction in the admin ingestion flow.

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
| `/business-card` | NFC card explainer |
| `/nfc` | NFC micro-page (widget-style) |
| `/privacy-policy` | Privacy policy |
| `/terms-of-service` | Terms of service |
