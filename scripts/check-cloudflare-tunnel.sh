#!/bin/bash

set -euo pipefail

HOSTNAME="${1:-dazbeez.com}"
RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

echo "Checking tunnel connectivity for $HOSTNAME..."
if ! HTTP_CODE="$(curl -sS -L -o "$RESPONSE_FILE" -w "%{http_code}" "https://$HOSTNAME")"; then
  echo "ERROR: Failed to reach https://$HOSTNAME"
  echo "Check local network connectivity, DNS, and Cloudflare status before retrying."
  exit 1
fi
CNAME_TARGET="$(dig +short CNAME "$HOSTNAME" | head -n 1 | sed 's/\.$//')"

print_recovery_steps() {
  echo "Recovery steps:"
  echo "  1. cp .env.example .env"
  echo "  2. Set CLOUDFLARE_TUNNEL_TOKEN in .env to the token from the dazbeez.com tunnel"
  echo "  3. Run: docker compose --profile production up -d --build"
  echo "  4. Confirm: docker compose --profile production ps"
  echo "  5. Inspect logs if needed: docker compose --profile production logs cloudflared --tail=50"
}

if [[ -n "$CNAME_TARGET" ]]; then
  echo "DNS CNAME target: $CNAME_TARGET"
else
  echo "DNS CNAME target: not exposed publicly (record may be proxied through Cloudflare)"
fi

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "SUCCESS: Tunnel is functioning correctly"
  echo "Origin server is reachable and tunnel is properly connected"
  exit 0
fi

if grep -Eqi "Error 1033|error code[:[:space:]]*1033" "$RESPONSE_FILE"; then
  echo "ERROR: Cloudflare returned Error 1033 for $HOSTNAME"
  echo "The tunnel is not connected to an active cloudflared origin."
  print_recovery_steps
  exit 1
fi

echo "INFO: Received HTTP $HTTP_CODE from https://$HOSTNAME"

if [[ "$HTTP_CODE" == "530" ]] && grep -qi "cloudflare" "$RESPONSE_FILE"; then
  echo "ERROR: Cloudflare is serving an origin/tunnel error page"
  print_recovery_steps
  exit 1
fi

echo "INFO: Tunnel did not return a 1033 page"
echo "This is likely an origin application or proxy issue rather than a missing tunnel."
exit 2
