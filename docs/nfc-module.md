# NFC Module

## Overview

The NFC module consists of two independent pieces:

1. **`/nfc` page** — a lightweight widget page on the main Next.js site for quick navigation (no contact capture)
2. **`networking-card/`** — a full Cloudflare Pages + D1 application for tokenized NFC card landing pages with OAuth-based contact capture

## BDD Framing

### Feature: Event-ready NFC networking flow

**Business goal:** turn a physical card tap into a low-friction digital handshake that works both in the moment and later.

#### Scenario: First tap at a networking event
- **Given** David hands a physical NFC card to a new contact at an event
- **When** the contact taps the card on their phone
- **Then** they should be able to save David&rsquo;s contact immediately
- **And** they should be offered the fastest possible way to share their own details
- **And** the tap should be logged even if they do not register yet

#### Scenario: Frictionless registration on mobile
- **Given** the contact wants to share their information quickly
- **When** they land on the tokenized card page
- **Then** Google GIS should be offered as the primary one-tap registration path
- **And** a manual fallback should remain available without blocking the fast path
- **And** LinkedIn should remain a destination CTA, not a sign-in dependency

#### Scenario: Later follow-up after the event
- **Given** the contact does not act immediately or wants more context later
- **When** they tap the same card again hours or days later
- **Then** the card should still give them David&rsquo;s contact details
- **And** it should provide clear next steps into services or inquiry
- **And** follow-up messaging should reinforce that return path

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
  → Show landing page: immediate vCard CTA, fast registration options, later-return hook
        ↓
[Google OAuth] ─────────── /auth/google/callback
[Manual form POST] ─────── /submit
        ↓ (all paths)
  → insertContact() → `contacts` table
  → sendDiscordNotification() (waitUntil)
  → sendAcknowledgmentEmail() with return link (waitUntil)
  → Redirect to /thanks?contact_id=<id>
        ↓
GET /thanks
  → Save vCard again + explore services/inquiry
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
5. Builds a Google Identity Services button configuration with the encoded state
6. Returns HTML page with:
   - Primary "Save David's contact" CTA
   - Google GIS sign-in button
   - Collapsible manual contact form
   - Hidden token field
   - "Tap again later" section with links to the explainer page, LinkedIn, services, and inquiry
   - Privacy disclaimer explaining the short-lived OAuth security cookie
7. Sets `__Host-oauth_state=<nonce>` cookie (HttpOnly, Secure, SameSite=Lax, Max-Age=300)

#### `GET /auth/google/callback` and `POST /auth/google/callback`

**File:** `networking-card/functions/auth/google/callback.ts`

CSRF verification flow:
1. Extract `state` from the request and decode it → `{ nonce, cardToken }`
2. Read `__Host-oauth_state` cookie
3. Assert `cookieNonce === stateData.nonce` — return 400 if mismatch
4. For GIS `POST`, also verify Google’s `g_csrf_token` double-submit cookie/body pair
5. Verify the Google ID token signature against Google JWKS, plus `aud`, `iss`, `exp`, and `nonce`
6. Call `insertContact()` with source = `"google"`
7. Fire Discord notification + acknowledgment email with a return link (both `waitUntil`)
8. Redirect to `/thanks?contact_id=<id>`

**Legacy note:** A `GET /auth/google/callback` code-exchange path still exists as a compatibility fallback, but the landing page now uses the GIS button flow.

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
- Links to services, inquiry, and David's LinkedIn profile
- Copy that encourages the visitor to tap the card again later when they want more information

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
| `GOOGLE_CLIENT_SECRET` | Optional | Legacy Google code-exchange fallback |
| `RESEND_API_KEY` | Yes | Acknowledgment emails from `david@dazbeez.com` |
| `DISCORD_WEBHOOK_URL` | Yes | Real-time contact notifications |
| `ADMIN_API_KEY` | Recommended | Shared secret for the admin contacts API |

D1 database binding: `DB` (configured in `wrangler.toml`).

Operational notes:
- Contacts are deduplicated per `token + email`.
- Every registration is also logged to `contact_events`, so Google, manual, and any legacy LinkedIn submissions remain visible even when they resolve to the same contact row.
- Failed Discord/email deliveries are logged to `notification_failures`.
- Admin API routes: `GET /admin/contacts` and `DELETE /admin/contacts/:id`.
- Main-site admin UI: `GET /admin` on the Next.js app fetches the live NFC admin feed server-side and shows card metrics, recent contacts, registration activity, and delete controls for contact removal.

### Admin Operations

There are now two admin surfaces for the networking-card data:

1. **Machine-readable API on the Cloudflare app**
   - `GET https://hi.dazbeez.com/admin/contacts`
   - `DELETE https://hi.dazbeez.com/admin/contacts/:id`
   - Auth: `Authorization: Bearer <ADMIN_API_KEY>` or `x-admin-key: <ADMIN_API_KEY>`

2. **Human-facing admin page on the main Next.js site**
   - `GET https://dazbeez.com/admin`
   - The page fetches the live NFC feed with server-side env vars:
     - `NFC_ADMIN_API_URL`
     - `NFC_ADMIN_API_KEY`
   - The NFC section shows:
     - an editable vCard profile form that updates the live `.vcf` download and saved-contact sheet
     - per-card tap/contact conversion metrics
     - recent captured contacts with all recorded methods used
     - recent registration activity for every sign-in/submission event
     - inline `Delete` controls that call the Cloudflare admin API through a server action

This keeps the admin API key on the server side while letting contact cleanup happen from the existing admin UI.

---

### OAuth App Setup

#### Google
- [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → OAuth 2.0 Client ID
- Authorized JavaScript origins:
  - `https://hi.dazbeez.com`
  - `http://localhost:8788`
- Authorized redirect URIs:
  - `https://hi.dazbeez.com/auth/google/callback`
  - `http://localhost:8788/auth/google/callback` (local dev)

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
