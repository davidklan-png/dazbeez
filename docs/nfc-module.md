# NFC Module

## Overview

The NFC module consists of two independent pieces:

1. **`/nfc` page** — a lightweight widget page on the main Next.js site for quick navigation (no contact capture)
2. **`networking-card/`** — a full Cloudflare Pages + D1 application for tokenized NFC card landing pages with OAuth-based contact capture

---

## Part 1: `/nfc` Page (Main Site)

**File:** `app/nfc/page.tsx`  
**Type:** Client component (`"use client"`)  
**Purpose:** Generic NFC tap destination — shows Dazbeez branding and 3 quick-action buttons

### Behavior

- Reads `?src=` query param on mount to identify tap source (e.g. card model, promo device)
- Displays source attribution at bottom of card: `"Scanned from: {source}"`
- Defaults to `"direct"` if no `src` param

### Quick Actions

| Button | Destination | Color |
|--------|-------------|-------|
| Start Inquiry | `/inquiry` | amber-500 |
| Our Services | `/services` | gray-900 |
| Contact Us | `/contact` | blue-500 |

### Usage

Program NFC tags to point to:
```
https://dazbeez.com/nfc?src=<card-identifier>
```

This page does **not** capture contact information. For full contact capture, use the tokenized networking card system below.

---

## Part 2: Networking Card System

**Location:** `networking-card/`  
**Runtime:** Cloudflare Pages + Pages Functions (Workers v8 isolate)  
**Database:** Cloudflare D1 (SQLite at edge)  
**Deploy command:** `npm run deploy` (from `networking-card/`)

---

### Data Flow

```
Physical NFC card / QR code
        ↓
GET /hi/:token
  → Log tap to `taps` table (async, before sign-in)
  → Show landing page: photo, pitch, 3 sign-in options
        ↓
[Google OAuth] ─────────── /auth/google/callback
[LinkedIn OAuth] ────────── /auth/linkedin/callback
[Manual form POST] ─────── /submit
        ↓ (all paths)
  → insertContact() → `contacts` table
  → sendDiscordNotification() (waitUntil)
  → sendAcknowledgmentEmail() (waitUntil)
  → Redirect to /thanks?contact_id=<id>
        ↓
GET /thanks
  → Download vCard button → GET /vcard/:contact_id
```

---

### Database Schema

**File:** `networking-card/migrations/0001_init.sql`

```sql
cards (
  token TEXT PRIMARY KEY,     -- random token programmed onto NFC tag
  label TEXT,                 -- human-readable card identifier
  created_at TEXT
)

contacts (
  id INTEGER AUTOINCREMENT,
  token TEXT → cards(token),
  name TEXT,
  email TEXT,
  source TEXT CHECK(IN 'google','linkedin','manual'),
  linkedin_url TEXT,
  company TEXT,
  cf_country TEXT,            -- from Cloudflare request.cf
  cf_city TEXT,
  user_agent TEXT,
  created_at TEXT
)

taps (
  id INTEGER AUTOINCREMENT,
  token TEXT → cards(token),
  cf_country TEXT,
  cf_city TEXT,
  user_agent TEXT,
  created_at TEXT
)
```

**Indexes:** `contacts(token)`, `taps(token)`, `taps(created_at)`

---

### Routes

#### `GET /hi/:token`

**File:** `networking-card/functions/hi/[token].ts`

1. Validates token exists in `cards` table — returns 404 if not
2. Logs tap to `taps` table via `context.waitUntil` (non-blocking)
3. Generates a cryptographic nonce (16 random bytes → hex string)
4. Encodes OAuth state as `btoa(nonce + ":" + token)`
5. Builds Google and LinkedIn OAuth URLs with the encoded state
6. Returns HTML page with:
   - "Sign in with Google" button
   - "Sign in with LinkedIn" button
   - Collapsible manual contact form
   - Hidden token field
   - Privacy disclaimer: *"Your info goes to David only, never shared."*
7. Sets `__Host-oauth_state=<nonce>` cookie (HttpOnly, Secure, SameSite=Lax, Max-Age=300)

#### `GET /auth/google/callback` and `GET /auth/linkedin/callback`

**Files:** `networking-card/functions/auth/google/callback.ts`, `networking-card/functions/auth/linkedin/callback.ts`

CSRF verification flow:
1. Extract `code` and `state` from query params
2. Decode state → `{ nonce, cardToken }`
3. Read `__Host-oauth_state` cookie
4. Assert `cookieNonce === stateData.nonce` — return 400 if mismatch
5. Exchange code for user profile (`name`, `email`)
6. Call `insertContact()` with source = `"google"` or `"linkedin"`
7. Fire Discord notification + acknowledgment email (both `waitUntil`)
8. Redirect to `/thanks?contact_id=<id>`

**Google token decoding note:** The JWT `id_token` uses base64url encoding. The implementation converts `-` → `+` and `_` → `/` before padding and calling `atob()` — see `decodeBase64Url()` in `_lib/oauth.ts`.

#### `POST /submit`

**File:** `networking-card/functions/submit.ts`

- Reads FormData: `token`, `name`, `email`, `company`, `linkedin_url`
- Validates required fields; verifies card token exists
- Inserts contact with `source: "manual"`
- Same downstream: Discord + email + redirect to `/thanks`

#### `GET /thanks`

Confirmation page with:
- Friendly success message
- "Download my contact card" button → links to `/vcard/:contact_id`
- Link to David's LinkedIn profile

#### `GET /vcard/:contact_id`

**File:** `networking-card/functions/vcard/[contact_id].ts`

- Returns David Klan's `.vcf` file regardless of `contact_id` (contact_id is passed for future per-contact logic)
- Content-Type: `text/vcard; charset=utf-8`
- Content-Disposition: `attachment; filename="david-klan.vcf"`

---

### Environment Variables / Secrets

Set via `npx wrangler pages secret put <SECRET> -p dazbeez-networking-card`.

| Secret | Required | Purpose |
|--------|----------|---------|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth app |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth app |
| `LINKEDIN_CLIENT_ID` | Yes | LinkedIn OAuth app |
| `LINKEDIN_CLIENT_SECRET` | Yes | LinkedIn OAuth app |
| `RESEND_API_KEY` | Yes | Acknowledgment emails from `david@dazbeez.com` |
| `DISCORD_WEBHOOK_URL` | Yes | Real-time contact notifications |

D1 database binding: `DB` (configured in `wrangler.toml`).

---

### OAuth App Setup

#### Google
- [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → OAuth 2.0 Client ID
- Authorized redirect URIs:
  - `https://dazbeez.com/auth/google/callback`
  - `http://localhost:8788/auth/google/callback` (local dev)

#### LinkedIn
- [LinkedIn Developer Portal](https://www.linkedin.com/developers/) → Create App → Auth
- Redirect URLs:
  - `https://dazbeez.com/auth/linkedin/callback`
  - `http://localhost:8788/auth/linkedin/callback` (local dev)
- Required scopes: `openid`, `email`, `profile`

---

### Card Seeding

**Script:** `networking-card/scripts/seed-cards.ts`

```bash
# Generate 20 cards (default)
npm run seed

# Specific count
npm run seed -- 50

# Custom base URL
npm run seed -- 50 https://hi.dazbeez.com
```

Outputs:
- `seed.sql` — INSERT statements for `cards` table
- `cards.csv` — token + URL pairs for QR/NFC programming

Apply to database:
```bash
# Local
npx wrangler d1 execute dazbeez-networking --local --file=seed.sql

# Production
npx wrangler d1 execute dazbeez-networking --remote --file=seed.sql
```

---

### Local Development

```bash
cd networking-card
npm install
npm run dev
# Open http://localhost:8788/hi/<token>
```

---

### Domain Setup Options

**Option A — Subdomain (recommended):**  
Assign `hi.dazbeez.com` as a custom domain on the Cloudflare Pages project.

**Option B — Path routing:**  
Add a Cloudflare Worker route on `dazbeez.com/hi/*` that proxies to the Pages project.

---

### Security Design

| Threat | Mitigation |
|--------|-----------|
| CSRF on OAuth callback | Per-page nonce stored in `__Host-` cookie; verified in callback |
| Token enumeration | Tokens are random (generated by seed script, not sequential) |
| Open redirect | Redirect target is always constructed from `url.origin`, never from user input |
| Contact spam | Token must exist in `cards` table; invalid tokens return 400 |
| Email header injection | Resend SDK handles email construction; no raw string concatenation |
| JWT base64url padding bug | `decodeBase64Url()` normalises before `atob()` |
| Credential exposure | All secrets stored in Cloudflare Pages secrets, not in repo |
