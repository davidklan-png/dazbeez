# Architecture

## Overview

Dazbeez is a Next.js 16.2.1 consulting website hosted on a local Mac M4 and served publicly via Cloudflare Tunnel. It consists of two independent deployable units:

| Unit | Purpose | Runtime |
|------|---------|---------|
| **Main site** (`/`) | Marketing, inquiry, contact, admin | Docker on Mac M4 |
| **Networking card** (`networking-card/`) | NFC/QR contact capture | Cloudflare Pages + Functions |

---

## Traffic Flow (Production)

```
Browser → Cloudflare CDN (dazbeez.com)
            ↓ Tunnel (QUIC)
         cloudflared container (network_mode: host)
            ↓ localhost:80
         Caddy (server-caddy, port 80, separate compose project)
            ↓ http://host.docker.internal:4488
         Next.js container (port 4488→3000)
```

`www.dazbeez.com` → Cloudflare redirect to `dazbeez.com` (handled at Caddy layer).

---

## Docker Compose Services

File: `docker-compose.yml`

### `nextjs` (always on)
- Build: multi-stage Node 20 Alpine (`Dockerfile`)
- Output: `next build` with `output: "standalone"`
- Port: `4488:3000` on host
- Healthcheck: `wget` to `127.0.0.1:3000` every 10s
- Restart: `unless-stopped`

### `nginx` (profile: `production`)
- Image: `nginx:alpine`
- Config: `docker/nginx.conf`
- Exposed (no host port) — listens on `:80` inside the Docker network
- Proxies to `nextjs:3000` with WebSocket upgrade headers
- **Note:** Currently unused in the live traffic path. Caddy handles ingress directly to port 4488.

### `cloudflared` (profile: `production`)
- Image: `cloudflare/cloudflared:latest`
- `network_mode: host` — sees `localhost:80` (Caddy)
- Credentials: `~/.cloudflared/<tunnel-id>.json` mounted read-only
- Tunnel ID: `e2d0eab2-b36f-4496-86a7-363d095fb78c` (`server-tunnel`)
- Restart: `unless-stopped`

### `ollama` (profile: `llm`)
- Image: `ollama/ollama:latest`
- Port: `11434:11434`
- Reserved for future chatbot enhancement — not active

---

## Cloudflare Tunnel

Tunnel name: `server-tunnel`  
Tunnel ID: `e2d0eab2-b36f-4496-86a7-363d095fb78c`

Remote ingress config (managed via Cloudflare dashboard):

| Hostname | Origin |
|----------|--------|
| `dazbeez.com` | `http://localhost:80` |
| `www.dazbeez.com` | `http://localhost:80` |
| `api.dazbeez.com` | `http://localhost:80` |
| `chat.dazbeez.com` | `http://localhost:80` |
| `*` | `http_status:404` |

Local fallback config: `docker/cloudflared-config.yml` (routes to `host.docker.internal:4488`).

Token management: `scripts/setup-keychain.sh` stores the tunnel token in macOS Keychain. `scripts/make-env.sh` regenerates `.env` from Keychain before starting the stack.

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
├── inquiry/page.tsx        # Chat-style inquiry flow (client component)
├── contact/page.tsx        # Contact form (client component)
├── nfc/page.tsx            # NFC landing widget (client component)
└── admin/page.tsx          # Internal dashboard (server component, noindex)

components/
├── site-navigation.tsx     # Sticky nav with mobile menu (client component)
└── admin/
    └── admin-dashboard.tsx # Dashboard presentation component

lib/
└── admin-dashboard-data.ts # Typed seed data for admin dashboard
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

## Key Ports

| Port | Service |
|------|---------|
| `4488` | Next.js (host) |
| `80` | Caddy (host, `server-caddy`) — routes to 4488 |
| `443` | Caddy (host, `server-caddy`) — TLS |
| `11434` | Ollama (reserved, `llm` profile) |
| `8788` | Cloudflare Pages local dev |

---

## Reboot / Recovery Procedure

1. Docker services restart automatically (`restart: unless-stopped`)
2. Wait for `dazbeez-nextjs` healthcheck → `healthy`
3. `cloudflared` retries connections automatically
4. Verify: `curl -s -o /dev/null -w "%{http_code}" http://localhost:4488`
5. End-to-end: `bash scripts/check-cloudflare-tunnel.sh dazbeez.com`

If `.env` is missing: `bash scripts/make-env.sh` (reads token from Keychain).
