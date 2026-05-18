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

## Key Conventions

### File Structure (App Router)
```
app/
├── layout.tsx          # Root layout (no _app.tsx or _document.tsx)
├── page.tsx            # Home page (root route)
├── globals.css         # Global styles (Tailwind)
├── [dynamic]/          # Dynamic routes use [bracket] syntax
└── .../
```

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
| Route | Purpose |
|-------|---------|
| `/` | Landing page |
| `/services` | Services list |
| `/services/[slug]` | Service detail (ai, automation, data, governance, pm) |
| `/contact` | Contact form (accepts `?service=<slug>` to preselect) |
| `/business-card` | Explainer for the NFC card |
| `/nfc` | NFC micro-page (widget-style) |
| `/api/contact` | POST endpoint for contact submissions (D1 persistence) |

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
