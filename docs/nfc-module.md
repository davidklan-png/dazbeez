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
  → Show landing page: immediate vCard CTA, GIS sign-in button, manual fallback
        ↓
[Google Identity Services POST credential] ─── POST /auth/google/callback
[Manual form POST] ─────────────────────────── POST /submit
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

#### `POST /auth/google/callback`

**File:** `networking-card/functions/auth/google/callback.ts`

The landing page uses a GIS JavaScript callback (`handleGisResponse`) which
creates a hidden form containing `credential` and `state`, then submits it to
this endpoint on the main page. Verification order:

1. Require `credential` and `state` on the form body; otherwise return a recoverable 400.
2. Decode `state` → `{ nonce, cardToken }`.
3. Read the `__Host-oauth_state` cookie and assert its value matches `state.nonce` — this binds the credential to the exact landing-page view and prevents CSRF.
4. Look up `state.cardToken` in the `cards` table.
5. Verify the Google ID token: RS256 signature against Google JWKS, plus `aud`, `iss`, `exp`, and the embedded `nonce` claim.
6. Call `saveContact()` with source = `"google"`.
7. Fire Discord notification + acknowledgment email with a return link (both `waitUntil`).
8. Redirect to `/thanks?contact_id=<id>`.

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
| `GOOGLE_CLIENT_ID` | Yes | Google Identity Services OAuth client ID (public — no secret required) |
| `RESEND_API_KEY` | Yes | Acknowledgment emails from `david@dazbeez.com` |
| `DISCORD_WEBHOOK_URL` | Yes | Real-time contact notifications |
| `ADMIN_API_KEY` | Recommended | Shared secret for the admin contacts API |

D1 database binding: `DB` (configured in `wrangler.jsonc`).

### Migration rules for `dazbeez-networking` (learned 2026-08-26 — see the ghost-FK incident)

> **Any migration that renames a table MUST first enumerate that table's
> referrers and rebuild them too.** Since SQLite 3.25, `ALTER TABLE … RENAME
> TO` rewrites `REFERENCES` clauses in other tables to follow the rename.
> `PRAGMA foreign_keys = OFF` does not suppress this — only
> `legacy_alter_table = ON` does. A subsequent `DROP` then leaves a ghost FK
> pointing at a table that no longer exists.
>
> **`PRAGMA foreign_key_check` does NOT detect this.** It validates rows, not
> schema targets, so a database full of NULL child keys looks perfectly
> clean. To detect ghosts, compare every `PRAGMA foreign_key_list(<table>)`
> target against `sqlite_master`.
>
> **This database's migrations are hand-applied via `d1 execute --file`.
> Never run `wrangler d1 migrations apply` against it.** `CRM_DB` declares no
> `migrations_dir`; a managed replay re-runs 0002's live `DELETE` and
> 0007/0009's rename-rebuild-drops against real data. This has already
> happened once — see the incident record — and it is what caused the outage.

Operational notes:
- Contacts are deduplicated per `token + email`.
- Every registration is also logged to `contact_events`, so Google, manual, and any legacy LinkedIn submissions remain visible even when they resolve to the same contact row.

#### KNOWN SCHEMA DEBT — shim table `batch_cards_old_fk_repair` (2026-08-26)

Production D1 (`dazbeez-networking`) contains an **empty shim table**:

```sql
CREATE TABLE IF NOT EXISTS batch_cards_old_fk_repair (id INTEGER PRIMARY KEY);
```

Why it exists: migration `0009` renamed `batch_cards` to rebuild it, which (SQLite ≥3.25
`ALTER TABLE … RENAME` semantics) retargeted the `REFERENCES batch_cards(id)` FKs in
`contact_events` and `business_card_images` at the repair-named table, then dropped it —
leaving ghost FKs. From 2026-05-20 every capture failed at the `contact_events` INSERT
(`no such table: main.batch_cards_old_fk_repair`, 503 on Google/LinkedIn/manual) while the
`contacts` row still saved. The shim makes the FK resolvable again; nothing in the live
capture path ever writes a non-NULL `batch_card_id`, so the shim is never read.

**Do not delete this table** until migration 0013 rebuilds `contact_events` and
`business_card_images` with the ghost FKs actually removed (architect plan of record:
`prompts/WORKER-PROMPT-nfc-ghost-fk-fix.md` §3). Dropping it first re-breaks all capture.
Convention: apply with `wrangler d1 execute --file`, never `d1 migrations apply`.
Also note `0012_mobile_capture.sql` is present in the repo but NOT applied to prod.

### Deploying the card (the real invocation — documented 2026-08-28)

The card deploys by **direct upload** (this Pages project has no git
integration; `origin/master` merges do NOT touch it). From
`networking-card/`:

```bash
npm run deploy
# = wrangler pages deploy --project-name dazbeez-networking-card \
#     --branch main --commit-dirty=true
```

- `--branch main` targets the **production** deployment (any other branch
  string creates a preview deployment and leaves production untouched).
- `--commit-dirty=true` is required in practice: this working tree always
  carries untracked files, and without the flag an interactive prompt blocks
  non-interactive deploys.
- No `--config`, no positional directory: `wrangler.jsonc` in the package
  dir supplies `pages_build_output_dir = "public"`. (Pages commands reject
  `--config`, and dropping it while a `wrangler.toml` name is used makes
  config discovery load the MONOREPO ROOT's `wrangler.jsonc` — the file must
  be named `wrangler.jsonc` so same-type-nearest-wins resolves ours. Proven
  2026-08-28; see `wrangler.jsonc`'s header comment.)

**Proof status of this command (as of 2026-08-28):** arg parsing, config
resolution, asset/function discovery from this directory, and API auth are
proven live (dev server + e2e run on the same discovery path; `pages project
list` authenticates and shows the project). The upload step itself is **not**
dry-runnable (`pages deploy` has no `--dry-run`) — the first execution was
left to the operator's deploy step, watched, per the cycle-1 go-ahead.

**Deploy order when a change touches BOTH the main app and the card** (e.g.
cycle 1's marketing token): tokens/D1 prerequisites first, then
master merge (main app auto-deploys), then this command. See
`prompts/WORKER-PROMPT-nfc-cycle-1.md` §4 for the concrete cycle-1 order.
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
- Authorized JavaScript origins (required by GIS):
  - `https://hi.dazbeez.com`
  - `http://localhost:8788`
- Authorized redirect URIs — add the same values so GIS will POST the credential to our `login_uri`:
  - `https://hi.dazbeez.com/auth/google/callback`
  - `http://localhost:8788/auth/google/callback` (local dev)
- Only the **Client ID** is needed; no client secret is used on the server side.

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
| CSRF on Google callback | Per-page nonce stored in `__Host-oauth_state` cookie; verified against the nonce encoded in the `state` form param. A JavaScript callback submits the credential on the main page (not a GIS popup), so the `SameSite=Lax` cookie is always sent. |
| Replay of a Google ID token to a different card | State encodes `{ nonce, cardToken }` and the nonce must match both the cookie and the JWT's `nonce` claim |
| Token enumeration | Tokens are random (generated by seed script, not sequential) |
| Open redirect | Redirect target is always constructed from `url.origin`, never from user input |
| Contact spam | Token must exist in `cards` table; invalid tokens return 400 |
| Email header injection | Resend SDK handles email construction; no raw string concatenation |
| JWT base64url padding bug | `decodeBase64Url()` normalises before `atob()` |
| Credential exposure | All secrets stored in Cloudflare Pages secrets, not in repo |
