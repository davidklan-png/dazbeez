# Dazbeez - AI Agent Guidelines

## Project Context

Dazbeez is a Next.js 16.2.1 website for AI, Automation & Data consulting services. The site is designed for local Mac M4 hosting with optional public access via Cloudflare Tunnel.

## Tech Stack

- **Framework:** Next.js 16.2.1 (App Router - not Pages Router!)
- **Styling:** Tailwind CSS (bee theme: amber/yellow + charcoal)
- **Deployment:** Docker Compose on Mac M4
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
| `/api/contact` | POST endpoint for contact submissions (JSONL persistence) |

> `/inquiry` has been retired and 308-redirects to `/contact`.

## When Making Changes

1. **Always use App Router patterns** - No `getStaticProps`, `getServerSideProps`
2. **Server components first** - Only add `"use client"` when needed
3. **Test responsive** - Check mobile (375px) and desktop (1024px+)
4. **Preserve bee theme** - Keep amber/yellow + charcoal color scheme
5. **Run dev server** - `npm run dev` to test changes

## Docker & Deployment

- Build: `docker build -t dazbeez .`
- Run: `docker-compose up -d`
- With LLM: `docker-compose --profile llm up -d`

## Cloudflare Tunnel

Traffic flow: `dazbeez.com → Cloudflare Tunnel (server-tunnel) → Caddy:80 → host.docker.internal:4488 → Next.js container`

The named tunnel `server-tunnel` is configured in `~/.cloudflared/config.yml` and runs as a launchd system daemon.
Caddy proxies `dazbeez.com` and `www.dazbeez.com` to `host.docker.internal:4488`.

Use the provided HTTPS URL for NFC tags.

## Reboot / Restart Procedure
1. Docker Compose services restart automatically (`restart: unless-stopped`)
2. Wait for nextjs container to report healthy before cloudflared will serve traffic
3. If cloudflared is a launchd service, it will retry connections — no action needed
4. If running cloudflared manually, use `docker/wait-for-healthy.sh`
5. Verify end-to-end: `curl -s -o /dev/null -w "%{http_code}" http://localhost:4488`

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
