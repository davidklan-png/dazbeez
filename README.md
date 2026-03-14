# Dazbeez

Company homepage.

## Run locally

```bash
s-app ~/projects/work/dazbeez up
open http://localhost:8100
```

## Caddy route (add to ~/server/infra/caddy/Caddyfile)

```
http://dazbeez.localhost, http://dazbeez.com {
    reverse_proxy dazbeez:8000
}
```
