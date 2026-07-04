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

echo "Smoke test passed for ${BASE_URL}"
