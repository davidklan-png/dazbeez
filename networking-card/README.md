# Dazbeez Networking Card

NFC/QR → immediate vCard access → Google GIS contact capture or manual form → Discord ping + acknowledgment email + later-return hook.

## Event Behavior

This flow is optimized for networking events where 15-20 physical cards may be handed out and people may tap either immediately or later on mobile.

- First tap: give the visitor David's contact card immediately and make sharing their own details feel low-friction.
- Later tap: bring the visitor back to a landing page that still works as a warm re-entry point into services or an inquiry.
- After registration: reinforce the return path in the thank-you page and follow-up email.

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

These scripts now include `migrations/0006_known_attendees.sql`, which creates the table used by the personalized post-tap flow.

### 3a. Seed event personalization (optional)

If you want the UH alumni event attendees to receive personalized thank-you copy and tier-specific follow-up prompts, apply the event seed after running migrations:

```bash
# Local development
npm run db:seed:uh-alumni:local

# Production
npm run db:seed:uh-alumni:remote
```

This loads `seed-uh-alumni-2026-04-22.sql` into `known_attendees`.

### 4. Set secrets

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID       -p dazbeez-networking-card
npx wrangler pages secret put RESEND_API_KEY          -p dazbeez-networking-card
npx wrangler pages secret put DISCORD_WEBHOOK_URL     -p dazbeez-networking-card
npx wrangler pages secret put ADMIN_API_KEY           -p dazbeez-networking-card
```

| Secret | Purpose |
|--------|---------|
| `GOOGLE_CLIENT_ID` | Google Identity Services client ID for the landing page button (public — no client secret is used) |
| `RESEND_API_KEY` | Resend API key for outbound email |
| `DISCORD_WEBHOOK_URL` | Discord channel webhook URL for notifications |
| `ADMIN_API_KEY` | Shared secret for the lightweight admin API |

### 5. OAuth app setup

#### Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) → Credentials
2. Create an OAuth 2.0 Client ID (Web application)
3. Add **Authorized JavaScript origins**:
   - `https://hi.dazbeez.com`
   - `http://localhost:8788`
4. Add **Authorized redirect URIs** (GIS posts the credential back to `login_uri`, which must appear here):
   - `https://hi.dazbeez.com/auth/google/callback`
   - `http://localhost:8788/auth/google/callback`
5. Copy the Client ID — the server never needs the Client Secret

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
npx wrangler --config wrangler.toml d1 execute dazbeez-networking --local  --file=seed.sql
npx wrangler --config wrangler.toml d1 execute dazbeez-networking --remote --file=seed.sql
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
| `/hi/:token` | GET | Landing page — logs tap, offers immediate vCard save, then frictionless registration |
| `/auth/google/callback` | POST | Google Identity Services callback — receives the signed credential, verifies CSRF + nonce + JWT, saves the contact |
| `/submit` | POST | Manual form handler — same downstream |
| `/thanks` | GET | Thank-you page with vCard download + return-path links |
| `/vcard/:contact_id` | GET | Serves `david-klan.vcf` |
| `/admin/contacts` | GET | Authenticated JSON view of contacts and per-card conversion counts |
| `/admin/contacts/:id` | DELETE | Authenticated contact deletion endpoint for PII removal |
| `/admin/vcard` | GET / PUT | Authenticated vCard profile read/update endpoint |

## Data Flow

1. Visitor taps NFC / scans QR → lands on `/hi/abc123`
2. Tap logged to `taps` table (every hit, before any sign-in)
3. Visitor can immediately save David's vCard from the landing page and see a sheet explaining what was saved and where the file usually lands
4. Visitor shares their own details with Google GIS or the manual form
5. Contact written to `contacts` table (deduplicated per `token + email`)
6. Registration event written to `contact_events` so every Google and manual submission is preserved, plus any legacy LinkedIn records already captured
7. Discord webhook fires with name, email, source, card label
8. Resend sends "Great meeting you" acknowledgment email with a return link
9. Any Discord/email failure is logged to `notification_failures` for later review
10. Visitor lands on `/thanks` with contact save + follow-up exploration links
11. Admin can edit the live vCard profile from `/admin` on the main site or via `PUT /admin/vcard`

## Domain Setup

This project runs as a Cloudflare Pages project. To route `dazbeez.com/hi/*` traffic to it:

**Option A — Subdomain (recommended):**
- Assign a custom domain like `hi.dazbeez.com` to the Pages project in the Cloudflare dashboard

**Option B — Path-based routing:**
- Use a Cloudflare Worker with a route on `dazbeez.com/hi/*` that proxies to the Pages project

## Privacy

The landing page includes: *"Your info goes to David only, never shared."*

No analytics beyond the `taps` table. No tracking pixels. A short-lived `__Host-oauth_state` cookie is used only during Google sign-in to prevent CSRF and expires after 5 minutes.
