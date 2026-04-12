# Dazbeez

AI, Automation & Data Solutions website built with Next.js 16.2.1.

> A modern consulting site featuring an interactive inquiry chatbot, service pages, and NFC-enabled micro-pages for quick access.

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
| `/services` | Services list |
| `/services/[slug]` | Service detail (ai, automation, data, governance, pm) |
| `/inquiry` | Interactive chatbot flow |
| `/contact` | Contact form |
| `/nfc` | NFC micro-page (widget-style) |

## Docker Healthcheck

The `nextjs` service has a healthcheck that polls `http://127.0.0.1:3000` every 10 seconds. The container is marked healthy after the first successful response (up to 5 retries after a 15-second start window).

```bash
# Check health status
docker inspect dazbeez-nextjs-1 --format='{{.State.Health.Status}}'
```
