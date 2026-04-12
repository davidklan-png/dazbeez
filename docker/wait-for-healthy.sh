#!/bin/bash
echo "Waiting for dazbeez-nextjs to be healthy..."
until [ "$(docker inspect --format='{{.State.Health.Status}}' \
  $(docker-compose ps -q nextjs))" = "healthy" ]; do
  sleep 2
done
echo "Ready. Starting cloudflared..."
TUNNEL_NAME="${1:-}"
if [[ -z "$TUNNEL_NAME" ]]; then
  echo "Usage: $0 <tunnel-name>" >&2
  exit 1
fi
cloudflared tunnel run "$TUNNEL_NAME"
