# Dazbeez

AI, Automation & Data Solutions website built with Next.js 16.2.1.

> A modern consulting site featuring an interactive inquiry chatbot, service pages, and NFC-enabled micro-pages for quick access.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Next.js 16.2.1](https://nextjs.org) (App Router) |
| Styling | [Tailwind CSS](https://tailwindcss.com) |
| Fonts | Inter (Google Fonts) |
| Deployment | Docker (Mac M4/ARM64 optimized) |
| Optional LLM | [Ollama](https://ollama.com) (for chatbot enhancement) |
| Tunnel | Cloudflare Tunnel (for public access) |

## Quick Start

### Development
1. Install dependencies with `npm install`.
2. Start the app with `npm run dev`.
3. Open `http://localhost:3000`.

### Production Deployment With Cloudflare Tunnel
`dazbeez.com` requires the Docker Compose `production` profile. Running only `docker compose up -d` starts the app container, but it does not start `nginx` or `cloudflared`, which leaves Cloudflare serving Error 1033.

1. Create the production env file:
   `cp .env.example .env`
2. Edit `.env` and set `CLOUDFLARE_TUNNEL_TOKEN` to the token for the `dazbeez.com` tunnel in Cloudflare Zero Trust.
3. Build and start the production stack:
   `docker compose --profile production up -d --build`
4. Confirm the tunnel path is running:
   `docker compose --profile production ps`
5. Verify public reachability:
   `./scripts/check-cloudflare-tunnel.sh dazbeez.com`

If Cloudflare shows Error 1033, the first things to check are:
- `.env` exists in the project root.
- `CLOUDFLARE_TUNNEL_TOKEN` is set correctly.
- `cloudflared` is running under the `production` profile.

Inspect tunnel logs with:
`docker compose --profile production logs cloudflared --tail=50`

### Direct Origin Checks
`./scripts/check-domain-resolution.sh` is for direct-origin validation against a local IP or reverse proxy. For the public `dazbeez.com` path behind Cloudflare Tunnel, use `./scripts/check-cloudflare-tunnel.sh` instead.

### Optional Ollama Profile
Start the LLM sidecar with:
`docker compose --profile llm up -d`
