#!/usr/bin/env bash
# NFC card weekly heartbeat — the instrument for "did the card do anything,
# and would I notice if it silently stopped?"
#
# Prints taps + captures for the last 7 days (UTC), excluding the test card,
# so David's own verification traffic never pollutes the number.
#
#   npm run stats:week          # print only (read-only, no sends)
#   ./scripts/weekly-heartbeat.sh --post   # also ping the Discord webhook
#                                          # (read from .dev.vars, never echoed)
#
# Why a script and not a dashboard: the 2026-05-20 → 2026-08-26 capture outage
# was invisible precisely because looking required going to look. This is the
# smallest thing that gets noticed without anyone opening a dashboard.
#
# Install the weekly push with scripts/com.dklan.nfc-heartbeat.plist
# (see README "Weekly heartbeat").

set -euo pipefail
cd "$(dirname "$0")/.."

# C1 test card — David's verification taps land on this token and are
# excluded from every metric. Override if the token changes.
TEST_TOKEN="${NFC_TEST_TOKEN:-mT7JWcIv}"

if date -u -v-7d +%Y-%m-%d >/dev/null 2>&1; then
  SINCE=$(date -u -v-7d +%Y-%m-%d)       # macOS/BSD
else
  SINCE=$(date -u -d '7 days ago' +%Y-%m-%d)  # GNU
fi

QUERY="SELECT
  (SELECT COUNT(*) FROM taps
    WHERE created_at >= '${SINCE}' AND token <> '${TEST_TOKEN}') AS taps,
  (SELECT COUNT(*) FROM contact_events
    WHERE created_at >= '${SINCE}' AND token <> '${TEST_TOKEN}') AS captures;"

RAW=$(npx wrangler d1 execute dazbeez-networking --remote --json --command "$QUERY" 2>/dev/null)

read -r TAPS CAPTURES < <(printf '%s' "$RAW" | python3 -c '
import json, sys
data = json.load(sys.stdin)
row = data[0]["results"][0]
print(row["taps"], row["captures"])
')

MESSAGE="🐝 NFC card, last 7 days (since ${SINCE}, test card excluded): ${TAPS} taps, ${CAPTURES} captures"

echo "$MESSAGE"

if [[ "${1:-}" == "--post" ]]; then
  # Webhook URL stays in .dev.vars; read it here without echoing.
  WEBHOOK=$(grep -m1 '^DISCORD_WEBHOOK_URL=' .dev.vars | cut -d= -f2- | tr -d '"' )
  if [[ -z "$WEBHOOK" ]]; then
    echo "No DISCORD_WEBHOOK_URL in .dev.vars — nothing posted." >&2
    exit 1
  fi
  curl -sf -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"content\":\"${MESSAGE}\"}" \
    "$WEBHOOK" >/dev/null
  echo "Posted to Discord."
fi
