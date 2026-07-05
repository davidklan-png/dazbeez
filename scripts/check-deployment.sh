#!/bin/bash

set -euo pipefail

BASE_URL="${1:-https://dazbeez.com}"

case "$BASE_URL" in
  http://*|https://*) ;;
  *)
    echo "Usage: $0 <base-url>"
    echo "Example: $0 https://dazbeez.com"
    echo "Example: $0 http://localhost:8787"
    exit 1
    ;;
esac

check_status() {
  local path="$1"
  local expected="$2"
  local code

  code="$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}${path}")"
  if [[ "$code" != "$expected" ]]; then
    echo "FAIL ${path}: expected ${expected}, got ${code}"
    exit 1
  fi
  echo "OK   ${path}: ${code}"
}

check_header() {
  local path="$1"
  local pattern="$2"

  if ! curl -I -s "${BASE_URL}${path}" | grep -Eiq "$pattern"; then
    echo "FAIL ${path}: missing header pattern ${pattern}"
    exit 1
  fi
  echo "OK   ${path}: header ${pattern}"
}

echo "Smoke testing ${BASE_URL}"

check_status "/" "200"
check_status "/services/ai" "200"
check_status "/contact" "200"
check_status "/manifest.webmanifest" "200"
check_status "/inquiry" "308"
# Clerk-gated routes (Phase 2): default curl sends Accept: */* which Clerk
# treats as a non-page request → notFound-rewrite → 404. Real browsers send
# Accept: text/html and get a 307 redirect to /receipts/sign-in. The 404
# status is enough to confirm "the route is gated" without needing to
# reproduce the browser Accept header here.
check_status "/admin" "404"
check_status "/receipts" "404"

check_header "/" "X-Frame-Options: SAMEORIGIN"
check_header "/" "X-Content-Type-Options: nosniff"
check_header "/" "Referrer-Policy: strict-origin-when-cross-origin"

# Processor-key HEAD check (Phase 2 regression guard for ADR 0001 consumer).
# The Mac MLX consumer authenticates to /api/receipts/<id>/file and /extract
# via x-receipts-processor-key. middleware.ts lists both routes in
# isPublicRoute so clerkMiddleware skips auth.protect() and lets the route
# handler do layered auth (processor key OR Clerk actor). Without that
# exemption, auth.protect() 404-rewrites the request before the handler runs
# — which silently dropped 17 receipts between Jul 4 (PR #59) and the fix.
# Source the key from the consumer .env if not already in the environment.
CONSUMER_ENV="$(dirname "$0")/receipts-consumer/.env"
if [[ -z "${RECEIPTS_PROCESSOR_KEY:-}" ]] && [[ -f "$CONSUMER_ENV" ]]; then
  RECEIPTS_PROCESSOR_KEY="$(grep -E '^RECEIPTS_PROCESSOR_KEY=' "$CONSUMER_ENV" | head -1 | cut -d= -f2-)"
fi
# Stable needs_review receipt; override via env if it ever 404s.
SMOKE_RECEIPT_ID="${SMOKE_RECEIPT_ID:-dabbd12e-b5a9-445d-98c9-3b824c145229}"

if [[ -z "${RECEIPTS_PROCESSOR_KEY:-}" ]]; then
  echo "SKIP /api/receipts/<id>/file (processor-key HEAD): RECEIPTS_PROCESSOR_KEY not set and $CONSUMER_ENV missing"
else
  processor_code="$(curl -sI -o /dev/null -w "%{http_code}" \
    -H "x-receipts-processor-key: $RECEIPTS_PROCESSOR_KEY" \
    "${BASE_URL}/api/receipts/${SMOKE_RECEIPT_ID}/file")"
  if [[ "$processor_code" != "200" ]]; then
    echo "FAIL /api/receipts/$SMOKE_RECEIPT_ID/file (processor-key HEAD): expected 200, got $processor_code"
    exit 1
  fi
  echo "OK   /api/receipts/$SMOKE_RECEIPT_ID/file (processor-key HEAD): 200"
fi

echo "Smoke test passed for ${BASE_URL}"
