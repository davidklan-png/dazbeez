# Dazbeez

AI, Automation & Data Solutions website built with Next.js 16.2.1.

> A modern consulting site featuring service pages, direct contact intake, and NFC-enabled micro-pages for quick access.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | [Next.js 16.2.1](https://nextjs.org) (App Router) |
| Styling | [Tailwind CSS](https://tailwindcss.com) |
| Fonts | Inter (Google Fonts) |
| Deployment | Docker Compose (Mac M4/ARM64 optimized) |
| Optional LLM | [Ollama](https://ollama.com) (for chatbot enhancement) |
| Tunnel | Cloudflare Tunnel → Caddy reverse proxy |

## Port Architecture

| Layer | Port | Notes |
|-------|------|-------|
| Next.js inside container | 3000 | Never changes — set in Dockerfile |
| Host binding | **4488** | Reserved port; maps host→container |
| Caddy reverse proxy | 80 | Routes `dazbeez.com` → `host.docker.internal:4488` |
| Cloudflare Tunnel | — | Routes public traffic → Caddy:80 |

Public traffic flow:
```
dazbeez.com → Cloudflare Tunnel → Caddy (localhost:80) → host.docker.internal:4488 → Next.js container (3000)
```

## Quick Start

### Development
1. Install dependencies with `npm install`.
2. Start the app with `npm run dev`.
3. Open `http://localhost:4488`.

### Production (Docker Compose)

```bash
# First deploy
docker-compose up -d --build

# Subsequent deploys
docker-compose down && docker-compose up -d --build

# Verify the app is responding
curl -s -o /dev/null -w "%{http_code}" http://localhost:4488
```

### Public Access

The primary public path for `dazbeez.com` is:

```text
dazbeez.com → Cloudflare Tunnel (server-tunnel) → Caddy:80 → host.docker.internal:4488 → Next.js container
```

That tunnel is managed outside this repo via `~/.cloudflared/config.yml`. The Docker Compose `production` profile still exists for repo-managed `nginx` and `cloudflared` containers when you explicitly want to run those services from Compose.

### Optional Ollama Profile

Start the LLM sidecar with:
`docker-compose --profile llm up -d`

## Reboot / Restart Procedure

1. Docker Compose services restart automatically (`restart: unless-stopped`)
2. The `dazbeez-nextjs` container has a healthcheck — Docker waits for it to be healthy
3. Cloudflare Tunnel (`server-tunnel`) runs as a **launchd system daemon** — it reconnects automatically
4. Caddy (`server-caddy-1`) also restarts automatically and routes traffic to `host.docker.internal:4488`
5. Verify end-to-end after reboot:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:4488
   ```

If cloudflared is not installed as a launchd service, use `docker/wait-for-healthy.sh` to wait for the container before starting it manually.

## Cloudflare Tunnel Setup

The site uses a named tunnel (`server-tunnel`) managed via `~/.cloudflared/config.yml`.

To update the tunnel config:
```bash
# Edit ~/.cloudflared/config.yml, then restart the service
sudo launchctl stop com.cloudflare.cloudflared
sudo launchctl start com.cloudflare.cloudflared
```

DNS records for `dazbeez.com` and `www.dazbeez.com` must be CNAME'd to the tunnel in the Cloudflare dashboard.

## Routes

| Route | Purpose |
|-------|---------|
| `/` | Landing page |
| `/about` | About David Klan |
| `/services` | Services list |
| `/services/[slug]` | Service detail (ai, automation, data, governance, pm) |
| `/contact` | Contact form |
| `/business-card` | NFC card explainer |
| `/nfc` | NFC micro-page (widget-style) |
| `/privacy-policy` | Privacy policy |
| `/terms-of-service` | Terms of service |

## Docker Healthcheck

The `nextjs` service has a healthcheck that polls `http://127.0.0.1:3000` every 10 seconds. The container is marked healthy after the first successful response (up to 5 retries after a 15-second start window).

```bash
# Check health status
docker inspect dazbeez-nextjs-1 --format='{{.State.Health.Status}}'
```
