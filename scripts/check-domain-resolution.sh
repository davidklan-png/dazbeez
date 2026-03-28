#!/bin/bash

# Script to verify that dazbeez.com resolves to the specified host IP.
# Uses DNS lookup plus curl --resolve so the request can be forced to a local
# origin or reverse proxy without changing public DNS.
#
# NOTE: This script is intended for direct-origin/DNS testing, not as the primary
# validation path for Cloudflare Tunnel deployments. For tunnel validation,
# use ./scripts/check-cloudflare-tunnel.sh instead.

set -euo pipefail

DOMAIN="dazbeez.com"
EXPECTED_IP="${1:-}"
PORT="${2:-80}"
SCHEME="${3:-http}"
CNAME_TARGET="$(dig +short CNAME "$DOMAIN" | head -n 1 | sed 's/\.$//')"

if [ "$PORT" = "80" ] && [ "$SCHEME" = "http" ]; then
  URL="$SCHEME://$DOMAIN"
elif [ "$PORT" = "443" ] && [ "$SCHEME" = "https" ]; then
  URL="$SCHEME://$DOMAIN"
else
  URL="$SCHEME://$DOMAIN:$PORT"
fi

if [ -z "$EXPECTED_IP" ]; then
  echo "Usage: $0 <expected_host_ip> [port] [scheme]"
  echo "Example: $0 192.168.1.100"
  echo "Example: $0 192.168.1.100 3000 http"
  exit 1
fi

echo "Verifying that $DOMAIN resolves to $EXPECTED_IP via $URL on port $PORT"

# Step 1: Check DNS resolution
echo "1. Checking DNS resolution..."
DNS_IP=$(dig +short "$DOMAIN" | head -1)

if [ -z "$DNS_IP" ]; then
  echo "ERROR: Could not resolve $DOMAIN via DNS"
  exit 1
fi

echo "   DNS resolved $DOMAIN to $DNS_IP"

if [[ -n "$CNAME_TARGET" ]] && [[ "$CNAME_TARGET" == *"cfargotunnel.com" ]]; then
  echo "   DNS uses Cloudflare Tunnel via $CNAME_TARGET"
  echo "   Public DNS will not resolve directly to the local origin IP"
  echo "   Use ./scripts/check-cloudflare-tunnel.sh for public tunnel verification"
elif [ "$DNS_IP" != "$EXPECTED_IP" ]; then
  echo "WARNING: DNS resolves to $DNS_IP, but expected $EXPECTED_IP"
  echo "This may be expected if DNS is managed by a CDN or proxy."
else
  echo "   DNS matches expected IP"
fi

# Step 2: Perform HTTP request with Host header override
echo "2. Testing HTTP access with Host override..."
if ! RESPONSE=$(curl -sS --location --resolve "$DOMAIN:$PORT:$EXPECTED_IP" "$URL/" --fail); then
  echo "ERROR: HTTP request failed for $URL/ through $EXPECTED_IP:$PORT"
  exit 1
fi

echo "   HTTP request successful"
echo "   Response length: ${#RESPONSE} characters"

# Step 3: Verify response content (basic check)
if [[ "$RESPONSE" == *"Dazbeez"* ]]; then
  echo "   Response contains expected content"
  echo "SUCCESS: $DOMAIN resolves correctly to $EXPECTED_IP"
  exit 0
else
  echo "WARNING: Response does not contain expected content"
  echo "   Response preview: ${RESPONSE:0:100}..."
  echo "This may be expected if the server returns a different page than expected."
fi
