# Dazbeez Networking Card

NFC/QR → landing page → sign-in (Google / LinkedIn / manual form) → Discord ping + acknowledgment email + vCard download.

## Stack

- **Cloudflare Pages + Functions** — routing, SSR, D1 access
- **D1** — SQLite database (cards, contacts, taps)
- **Resend** — acknowledgment emails from david@dazbeez.com
- **Discord webhook** — instant notification on every new contact

## Quick Start

### 1. Install dependencies

```bash
cd networking-card
npm install
```

### 2. Create D1 database

```bash
npx wrangler d1 create dazbeez-networking
```

Copy the `database_id` from the output into `wrangler.toml`.

### 3. Run migrations

```bash
# Local development
npm run db:migrate:local

# Production
npm run db:migrate:remote
```

### 4. Set secrets

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID       -p dazbeez-networking-card
npx wrangler pages secret put GOOGLE_CLIENT_SECRET    -p dazbeez-networking-card
npx wrangler pages secret put LINKEDIN_CLIENT_ID      -p dazbeez-networking-card
npx wrangler pages secret put LINKEDIN_CLIENT_SECRET  -p dazbeez-networking-card
npx wrangler pages secret put RESEND_API_KEY          -p dazbeez-networking-card
npx wrangler pages secret put DISCORD_WEBHOOK_URL     -p dazbeez-networking-card
```

| Secret | Purpose |
|--------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret |
| `LINKEDIN_CLIENT_ID` | LinkedIn OAuth 2.0 Client ID |
| `LINKEDIN_CLIENT_SECRET` | LinkedIn OAuth 2.0 Client Secret |
| `RESEND_API_KEY` | Resend API key for outbound email |
| `DISCORD_WEBHOOK_URL` | Discord channel webhook URL for notifications |

### 5. OAuth app setup

#### Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) → Credentials
2. Create an OAuth 2.0 Client ID (Web application)
3. Add **Authorized redirect URI**: `https://dazbeez.com/auth/google/callback`
4. For local dev also add: `http://localhost:8788/auth/google/callback`
5. Copy the Client ID and Client Secret

#### LinkedIn

1. Open [LinkedIn Developer Portal](https://www.linkedin.com/developers/) → Create App
2. Auth tab → Add redirect URL: `https://dazbeez.com/auth/linkedin/callback`
3. For local dev also add: `http://localhost:8788/auth/linkedin/callback`
4. Request the `openid`, `email`, `profile` scopes (OpenID Connect)
5. Copy the Client ID and Client Secret

### 6. Resend DNS

1. Add `dazbeez.com` in the [Resend Domains dashboard](https://resend.com/domains)
2. Add the required DNS records (SPF, DKIM, DMARC) to your DNS provider
3. Wait for domain verification to complete

### 7. Seed cards

```bash
# Generate 20 cards (default)
npm run seed

# Generate a specific count
npm run seed -- 50

# With a custom base URL
npm run seed -- 50 https://hi.dazbeez.com
```

This creates `seed.sql` and `cards.csv`. Apply the SQL:

```bash
npx wrangler d1 execute dazbeez-networking --local  --file=seed.sql
npx wrangler d1 execute dazbeez-networking --remote --file=seed.sql
```

Use `cards.csv` to generate QR codes or program NFC tags.

### 8. Develop locally

```bash
npm run dev
# Open http://localhost:8788/hi/<token-from-cards.csv>
```

### 9. Deploy

```bash
npm run deploy
```

## Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/hi/:token` | GET | Landing page — logs tap, shows photo + pitch + 3 CTAs |
| `/auth/google/callback` | GET | Google OAuth callback — creates contact, fires notifications |
| `/auth/linkedin/callback` | GET | LinkedIn OAuth callback — same flow |
| `/submit` | POST | Manual form handler — same downstream |
| `/thanks` | GET | Thank-you page with vCard download + LinkedIn link |
| `/vcard/:contact_id` | GET | Serves `david-klan.vcf` |

## Data Flow

1. Visitor taps NFC / scans QR → lands on `/hi/abc123`
2. Tap logged to `taps` table (every hit, before any sign-in)
3. Visitor picks Google, LinkedIn, or manual form
4. Contact written to `contacts` table
5. Discord webhook fires with name, email, source, card label
6. Resend sends "Great meeting you" acknowledgment email
7. Visitor lands on `/thanks` with vCard download

## Domain Setup

This project runs as a Cloudflare Pages project. To route `dazbeez.com/hi/*` traffic to it:

**Option A — Subdomain (recommended):**
- Assign a custom domain like `hi.dazbeez.com` to the Pages project in the Cloudflare dashboard

**Option B — Path-based routing:**
- Use a Cloudflare Worker with a route on `dazbeez.com/hi/*` that proxies to the Pages project

## Privacy

The landing page includes: *"Your info goes to David only, never shared."*

No analytics beyond the `taps` table. No cookies, no tracking pixels.
