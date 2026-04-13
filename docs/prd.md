# Product Requirements Document (PRD)

## Product Overview

**Product:** Dazbeez  
**Version:** 0.1.0  
**Type:** Consulting website + lead capture system  
**Audience:** Businesses seeking AI, Automation, and Data consulting services  
**Owner:** David Klan  

---

## Problem Statement

A solo consultant needs a professional web presence that:
- Accurately represents service offerings across AI, Automation, Data, Governance, and Project Management
- Guides prospective clients to the right service through a low-friction interactive flow
- Captures leads without requiring a backend SaaS — the site runs entirely on a local Mac M4 with optional public access
- Enables networking at offline events via NFC-enabled business cards that capture contact information
- Provides an internal operations dashboard without exposing sensitive data publicly

---

## Goals

| Goal | Metric |
|------|--------|
| Establish professional online presence | Live at `dazbeez.com` with SSL, OG metadata, sitemap |
| Convert visitors to inquiries | Inquiry flow completion rate |
| Capture networking contacts | Tap and contact records in D1 per card |
| Maintain operational awareness | Admin dashboard showing KPIs, leads, activity |
| Zero external backend dependency | All infrastructure self-hosted or edge-native |

---

## Non-Goals

- E-commerce / payment processing
- User accounts / authentication on main site
- CMS / content management UI
- Real-time chat with agents (currently scripted; Ollama reserved for future enhancement)
- Blog / content marketing

---

## User Personas

### Sarah — Prospective Client
- Business owner or decision-maker exploring digital transformation
- Arrived via Google search, LinkedIn referral, or NFC card at a networking event
- Needs to understand services and take a low-commitment first step (inquiry or contact form)

### David — Site Owner / Consultant
- Monitors inquiries and lead pipeline via admin dashboard
- Hands out NFC cards offline; reviews new contact notifications in Discord
- Manages infrastructure locally on Mac M4

---

## Features

### F1: Marketing Site

**Routes:** `/`, `/services`, `/services/[slug]`

| Requirement | Detail |
|-------------|--------|
| Service catalog | 5 services: AI Integration, Automation, Data Management, Governance, Project Management |
| Static generation | Service detail pages pre-rendered via `generateStaticParams` |
| SEO | Title/description metadata, canonical URLs, OG tags, Twitter cards, sitemap, robots.txt |
| OG image | Dynamically generated via `app/opengraph-image.tsx` (1200×630) |
| Navigation | Sticky, frosted-glass, responsive (desktop links + mobile hamburger) |
| Footer | Service links + connect links, dynamic copyright year |

### F2: Interactive Inquiry Flow

**Route:** `/inquiry`

| Requirement | Detail |
|-------------|--------|
| Chat-style UI | Scrollable message thread, user and assistant bubbles |
| Scripted routing | Keyword-matched decision tree covering 5 service branches |
| Option buttons | Pre-defined choices rendered inside assistant messages |
| Freeform input | Text input + Enter key; falls back to generic recommendation |
| Typing indicator | Animated 3-dot loop during simulated LLM response delay |
| Contact form escape | "Talk to human" path shows inline contact form overlay |
| Ollama hook | Architecture reserved; `setTimeout` placeholder for LLM calls |

**Decision Tree (top level):**

```
greeting
  ├── "automate" → automate branch
  ├── "data"     → data branch  
  ├── "ai"       → ai branch
  ├── "project"  → project branch
  └── default    → not-sure → done
                           └── "human" → contact form
```

### F3: Contact Form

**Route:** `/contact`

| Requirement | Detail |
|-------------|--------|
| Fields | First name, last name, email (required); company, service interest, message |
| Validation | HTML5 native `required` attributes |
| Success state | Replaces form with green checkmark card |
| Backend | Currently front-end only; `handleSubmit` logs to console (TODO: persist) |
| Response SLA | "Within 24 hours" shown in UI |

### F4: NFC Landing Page

**Route:** `/nfc`

| Requirement | Detail |
|-------------|--------|
| Widget style | Full-screen dark gradient, centered card (max-w-sm) |
| Source tracking | `?src=` query param captured and displayed |
| Quick actions | 3 buttons: Start Inquiry, Our Services, Contact Us |
| No layout chrome | NFC page bypasses standard nav/footer (full screen design) |
| Ping animation | Visual indicator that NFC was detected |

### F5: Networking Card System

**Location:** `networking-card/` (Cloudflare Pages)

| Requirement | Detail |
|-------------|--------|
| NFC/QR landing | Tokenized URL (`/hi/:token`) per physical card |
| Tap logging | Every visit logged to `taps` table before any sign-in |
| Identity capture | Google OAuth, LinkedIn OAuth, or manual form |
| CSRF protection | Per-page nonce via `__Host-oauth_state` cookie |
| Downstream actions | Discord notification + Resend acknowledgment email + redirect to `/thanks` |
| vCard download | `.vcf` file served at `/vcard/:contact_id` |
| Privacy statement | "Your info goes to David only, never shared." shown on landing page |
| Card seeding | CLI script generates tokens, outputs `seed.sql` + `cards.csv` for NFC programming |

### F6: Admin Dashboard

**Route:** `/admin`

| Requirement | Detail |
|-------------|--------|
| Access control | Route is not publicly linked; `robots: noindex` |
| KPI cards | Total Inquiries, Active Leads, Conversion Rate, Revenue (Q1) |
| Service interest | Horizontal bar chart by service name |
| Lead pipeline | Table with company, contact, service, status badge, deal value |
| Lead statuses | new, contacted, proposal, won, lost (color-coded badges) |
| Recent activity | Timestamped activity feed |
| Pending actions | Priority-coded todo list (high=red, medium=amber, low=green) |
| Data source | Static typed seed data in `lib/admin-dashboard-data.ts` (no live DB yet) |
| Rendering | Server component — no client-side data fetching |

---

## Technical Requirements

| Requirement | Detail |
|-------------|--------|
| Framework | Next.js 16.2.1 App Router |
| Styling | Tailwind CSS, bee theme (amber + charcoal) |
| Build | `next build` with `output: "standalone"` |
| Runtime | Node 20 Alpine (Docker), ARM64 (Mac M4) |
| TypeScript | Strict mode |
| Public access | Cloudflare Tunnel (named tunnel `server-tunnel`) |
| Token security | Cloudflare tunnel token stored in macOS Keychain, not in repo |
| SEO | Full metadata, OG, sitemap, robots |
| No external analytics | No tracking scripts, no cookies on main site |

---

## Out-of-Scope (Future Backlog)

| Item | Notes |
|------|-------|
| Ollama chatbot integration | Container reserved (`llm` profile); inquiry flow has hook |
| Contact form persistence | `// TODO: Save to local JSON file` in `contact/page.tsx` |
| Admin dashboard live data | Replace seed data with real inquiry/lead sources |
| `api.dazbeez.com` | Tunnel route reserved, no handler yet |
| `chat.dazbeez.com` | Tunnel route reserved, no handler yet |
| Networking card analytics | Tap counts by country/city visible in D1 but not surfaced in admin |
