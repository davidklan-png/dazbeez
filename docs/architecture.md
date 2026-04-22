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
