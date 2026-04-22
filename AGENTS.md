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

## Verification
1. Run `npm run build:cf` before shipping deployment changes
2. For Cloudflare runtime checks, run `npm run cf:dev`
3. Smoke-test the deployment with `bash scripts/check-deployment.sh <base-url>`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
