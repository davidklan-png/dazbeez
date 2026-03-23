# Dazbeez

AI, Automation & Data Solutions website built with Next.js 15.

> A modern consulting site featuring an interactive inquiry chatbot, service pages, and NFC-enabled micro-pages for quick access.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Next.js 15](https://nextjs.org) (App Router) |
| Styling | [Tailwind CSS](https://tailwindcss.com) |
| Fonts | Inter (Google Fonts) |
| Deployment | Docker (Mac M4/ARM64 optimized) |
| Optional LLM | [Ollama](https://ollama.com) (for chatbot enhancement) |
| Tunnel | Cloudflare Tunnel (for public access) |

## Quick Start

### Development

```bash
cd dazbeez
npm install
npm run dev
```

Open http://localhost:3000

### Production (Docker)

```bash
docker-compose up -d
```

Open http://localhost:80 (with nginx proxy)

### With LLM Backend

```bash
docker-compose --profile llm up -d
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | Landing page with hero section and service cards |
| `/services` | Services overview |
| `/services/ai` | AI Integration details |
| `/services/automation` | Automation services |
| `/services/data` | Data Management |
| `/services/governance` | Governance & Compliance |
| `/services/pm` | Project Management |
| `/inquiry` | Interactive chatbot flow |
| `/contact` | Contact form |
| `/nfc` | NFC micro-page (widget-style, source tracking) |

## Features

### Interactive Inquiry Flow
- Scripted decision tree for common queries
- LLM fallback for unscripted questions
- Progress tracking and quick-response options
- Seamless handoff to contact form

### NFC Micro-Page
- Widget-style design optimized for mobile
- Source tracking via URL params (`?src=card`, `?src=promo`)
- Quick-action buttons for instant access

### Bee Theme
- Primary: Amber 500 (#F59E0B)
- Secondary: Amber 400 (#FBBF24)
- Dark: Gray 900 (#111827)
- Charcoal: Gray 800 (#1F2937)

## NFC Tag Setup

Program your NFC tags with these URLs:

```
# Business card
https://yourdomain.com/nfc?src=card

# Promo device (customizable)
https://yourdomain.com/nfc?src=promo-eventname

# Demo widget
https://yourdomain.com/nfc?src=demo
```

## Cloudflare Tunnel (Public Access)

To expose your local site publicly without port forwarding:

```bash
# Install cloudflared
brew install cloudflare/tap/cloudflared

# Start tunnel
cloudflared tunnel --url http://localhost:3000
```

Use the provided `https://` URL for your NFC tags and sharing.

## Contact Form

Currently uses client-side state. For production, implement:

- API route (`app/api/contact/route.ts`) to handle form submissions
- Save to local JSON file or database
- Send email notification (Resend, SendGrid, etc.)

## Project Structure

```
dazbeez/
├── app/
│   ├── layout.tsx           # Root layout with nav + footer
│   ├── page.tsx             # Landing page
│   ├── globals.css          # Global styles
│   ├── inquiry/
│   │   └── page.tsx         # Chatbot flow (client component)
│   ├── services/
│   │   ├── page.tsx         # Services overview
│   │   └── [slug]/
│   │       └── page.tsx     # Dynamic service pages
│   ├── contact/
│   │   └── page.tsx         # Contact form
│   └── nfc/
│       └── page.tsx         # NFC micro-page
├── docker/
│   ├── nginx.conf           # Nginx config
│   └── docker-compose.yml   # Docker services
├── public/                  # Static assets
├── Dockerfile               # Multi-stage build
├── next.config.ts           # Next.js config
├── tailwind.config.ts       # Tailwind config
└── package.json
```

## Development

```bash
# Install dependencies
npm install

# Run dev server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run with Docker
docker-compose up

# Run with LLM backend
docker-compose --profile llm up
```

## License

© 2025 Dazbeez. All rights reserved.
