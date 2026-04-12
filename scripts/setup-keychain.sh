#!/bin/bash
# Stores CLOUDFLARE_TUNNEL_TOKEN in macOS Keychain.
# Run once on initial setup, or to rotate the token.
# After running, the .env file is no longer needed and can be deleted.
#
# Usage:
#   ./scripts/setup-keychain.sh          # reads token from .env if present
#   ./scripts/setup-keychain.sh --prompt  # always prompt for token interactively

set -euo pipefail

KEYCHAIN_SERVICE="dazbeez-cloudflare-tunnel-token"
KEYCHAIN_ACCOUNT="$USER"
ENV_FILE="$(dirname "$0")/../.env"

echo "=== Dazbeez Keychain Setup ==="

# Determine token value
TOKEN=""

if [[ "${1:-}" == "--prompt" ]]; then
  read -r -s -p "Paste CLOUDFLARE_TUNNEL_TOKEN: " TOKEN
  echo
elif [[ -f "$ENV_FILE" ]]; then
  TOKEN="$(grep -E '^CLOUDFLARE_TUNNEL_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
  if [[ -z "$TOKEN" ]]; then
    echo "ERROR: CLOUDFLARE_TUNNEL_TOKEN is not set in $ENV_FILE"
    echo "Run with --prompt to enter it interactively:"
    echo "  ./scripts/setup-keychain.sh --prompt"
    exit 1
  fi
  echo "Read token from .env"
else
  read -r -s -p "No .env found. Paste CLOUDFLARE_TUNNEL_TOKEN: " TOKEN
  echo
fi

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: Token cannot be empty."
  exit 1
fi

# Store in Keychain (replaces existing entry if present)
security add-generic-password \
  -a "$KEYCHAIN_ACCOUNT" \
  -s "$KEYCHAIN_SERVICE" \
  -w "$TOKEN" \
  -U 2>/dev/null

echo "Token stored in macOS Keychain under service '$KEYCHAIN_SERVICE'."
echo ""
echo "You can now delete the .env file — regenerate it anytime with:"
echo "  ./scripts/make-env.sh"
