# Dazbeez Docs

Internal documentation for the Dazbeez consulting website and related systems.

## Contents

| Document | Description |
|----------|-------------|
| [architecture.md](architecture.md) | System architecture, infrastructure, Docker services, traffic flow |
| [ui-ux.md](ui-ux.md) | Design system, color palette, typography, component inventory, page layouts |
| [prd.md](prd.md) | Product requirements, features, personas, goals, backlog |
| [admin-dashboard.md](admin-dashboard.md) | Admin route, data model, component reference, security notes |
| [inquiry-workflow.md](inquiry-workflow.md) | Chat flow, decision tree, routing logic, extension guide |
| [nfc-module.md](nfc-module.md) | NFC `/nfc` page + networking card system (Cloudflare Pages, D1, OAuth) |

## Quick Reference

### Deploy the main site

```bash
npm run build:cf
npm run deploy
bash scripts/check-deployment.sh https://dazbeez.com
```

### Development

```bash
npm run dev           # Next.js dev server (port 4488)
npm run cf:dev        # OpenNext/Workers local preview (port 8787)
cd networking-card && npm run dev   # Cloudflare Pages local (port 8788)
```

### Routes

| URL | Purpose |
|-----|---------|
| `https://dazbeez.com/` | Home page |
| `https://dazbeez.com/services` | Services listing |
| `https://dazbeez.com/services/[slug]` | Service detail (ai, automation, data, governance, pm) |
| `https://dazbeez.com/contact` | Contact form |
| `https://dazbeez.com/nfc` | NFC quick-access widget |
| `https://dazbeez.com/admin` | Internal operations dashboard (not publicly linked) |
| `https://dazbeez.com/hi/:token` | Networking card NFC landing (Cloudflare Pages) |
