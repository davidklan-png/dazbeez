# Dazbeez - AI Agent Guidelines

## Project Context

Dazbeez is a Next.js 16.2.3 website for AI, Automation & Data consulting services. Production now runs on Cloudflare Workers via OpenNext, with Cloudflare D1 used for contact submission persistence.

## Tech Stack

- **Framework:** Next.js 16.2.3 (App Router - not Pages Router!)
- **Styling:** Tailwind CSS (bee theme: amber/yellow + charcoal)
- **Production Runtime:** Cloudflare Workers via OpenNext
- **Persistence:** Cloudflare D1
- **Local Reference Runtime:** Docker Compose on Mac M4
- **Optional LLM:** Ollama for chatbot enhancement

### Cloudflare Bindings (`wrangler.jsonc`)

| Binding | Type | Backs |
|---------|------|-------|
| `DB` | D1 (`dazbeez-submissions`) | Public contact-form submissions |
| `CRM_DB` | D1 (`dazbeez-networking`) | CRM / networking data |
| `RECEIPTS_DB` | D1 (`dazbeez-receipts`) | Receipts module (`migrations_dir: db/receipts`) |
| `CRM_IMAGES` | R2 (`dazbeez-crm-images`) | CRM card/contact images |
| `RECEIPTS_BUCKET` | R2 (`dazbeez-receipts`) | Receipt files |
| `RECEIPTS_ARCHIVE_BUCKET` | R2 (`dazbeez-receipts-archive`) | Archived receipts |
| `AI` | Workers AI | Extraction / LLM tasks |
| `ASSETS` · `WORKER_SELF_REFERENCE` | Worker | OpenNext asset serving + self-reference |

> Secrets (`RESEND_API_KEY`, `GOOGLE_CLOUD_VISION_API_KEY`) are set via `wrangler secret put`, not committed.

## Key Conventions

### File Structure (App Router)
```
app/                    # Routes, layouts, and API handlers (App Router)
├── layout.tsx          # Root layout (no _app.tsx or _document.tsx)
├── page.tsx            # Home page (root route)
├── globals.css         # Global styles (Tailwind)
├── [dynamic]/          # Dynamic routes use [bracket] syntax
├── (receipt-system)/   # Route group for the receipts UI
├── admin/              # Internal admin console (noindex)
├── api/                # Route handlers (contact, receipts, mobile, nfc, vcard)
└── .../
components/             # Shared React components (all "use client" UI lives here)
├── ui/                 # Primitives (btn, card, field, ...)
├── receipts/           # Receipts-specific components
└── admin/              # Admin console components
lib/                    # Non-component logic (services, CRM, receipts, helpers)
└── receipts/           # Receipts domain logic
db/receipts/            # D1 SQL migrations for the receipts DB
```

> Interactive components are isolated under `components/`; route files in `app/`
> stay server components by default and import client components from there.

### Styling Guidelines
- Use bee colors: `amber-500` (#F59E0B) primary, `gray-900` (#111827) dark
- Rounded corners: `rounded-xl` or `rounded-2xl`
- Hover states: `hover:opacity-90` or `hover:bg-amber-600`
- Responsive: `md:` and `lg:` breakpoints

### Component Patterns
- Server components by default (no "use client")
- Client components only for interactivity (forms, animations)
- Use `Link` from `next/link` for navigation
- Use `Image` from `next/image` for optimized images

### Routes

**Public marketing site**

| Route | Purpose |
|-------|---------|
| `/` | Landing page |
| `/services` | Services list |
| `/services/[slug]` | Service detail (ai, automation, data, governance, pm) |
| `/contact` | Contact form (accepts `?service=<slug>` to preselect) |
| `/business-card` | Explainer for the NFC card |
| `/nfc` | NFC micro-page (widget-style) |
| `/about` | About page |
| `/case-studies` · `/case-studies/[slug]` | Case studies list + detail |
| `/privacy-policy` · `/terms-of-service` | Legal pages |

**API & internal**

| Route | Purpose |
|-------|---------|
| `/api/contact` | POST endpoint for contact submissions (D1 persistence) |
| `/api/receipts/*` | Receipts capture, extract, reconcile, export, devices, compliance |
| `/api/mobile/*` | Mobile pairing/auth + receipt & business-card uploads |
| `/api/nfc/hit` · `/api/vcard` | NFC tap tracking + vCard download |
| `/admin/*` | Internal admin console (CRM, batches, review) — `noindex` |
| `/.well-known/security.txt` | Security contact disclosure |

> The receipts UI itself lives under the `(receipt-system)` route group — see
> the Receipts Module section below.

> `/inquiry` has been retired and 308-redirects to `/contact`.

## When Making Changes

1. **Always use App Router patterns** - No `getStaticProps`, `getServerSideProps`
2. **Server components first** - Only add `"use client"` when needed
3. **Test responsive** - Check mobile (375px) and desktop (1024px+)
4. **Preserve bee theme** - Keep amber/yellow + charcoal color scheme
5. **Run dev server** - `npm run dev` to test changes

## Deployment

- Cloudflare build: `npm run build:cf`
- Local Workers preview: `npm run cf:dev`
- Deploy worker: `npm run deploy`

## Docker Reference

- `Dockerfile` and `docker-compose.yml` are kept only for local/reference workflows.
- The `llm` Compose profile is local-only and does not participate in production.

## Receipts Module — All-Mac Development

The receipts module (`app/(receipt-system)/receipts/`, `app/api/receipts/`, `lib/receipts/`) is developed end-to-end on the Mac M4 with live Cloudflare bindings. The previous PC/Mac split has been retired — all coding, building, testing, and deployment happen on the Mac.

### Mac M4 — Single Source of Truth

- Owns `wrangler.jsonc` bindings for D1 (`RECEIPTS_DB`, `CRM_DB`), R2 (`RECEIPTS_BUCKET`, `RECEIPTS_ARCHIVE_BUCKET`), and any AI bindings
- Holds Cloudflare Tunnel config, Access policies, and auth keys
- Runs SQL migrations against live D1
- Runs `npm run dev` for fast UI iteration and `npm run cf:dev` for end-to-end runtime testing against real bindings
- Runs `npm run build:cf` to validate production builds
- Deploys via `npm run deploy`

### Workflow

1. Branch from `main` on the Mac
2. Implement + run `npm run cf:dev` against real bindings to verify behavior
3. `npm run build:cf` must pass
4. Smoke-test with `bash scripts/check-deployment.sh <base-url>` after deploy
5. Commit, push, open PR, merge, deploy

### Cloud / Remote Sessions

When Claude Code runs in a cloud sandbox (e.g. claude.ai/code web session) the container does **not** have the Mac's credentials, `wrangler.jsonc` secrets, or D1/R2 access. In that environment:

- Treat the session as code-only: edit, `tsc --noEmit`, run unit tests with mocked bindings, commit, push
- Do not attempt `wrangler dev`, `cf:dev`, or `deploy` — they will fail without bindings
- For any change that depends on live D1/R2 behavior, hand off to the Mac for verification and deploy

## Verification
1. Run `npm run build:cf` before shipping deployment changes
2. For Cloudflare runtime checks, run `npm run cf:dev`
3. Smoke-test the deployment with `bash scripts/check-deployment.sh <base-url>`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
