#!/usr/bin/env bash
# Safe launcher for the read-only queue-configuration verifier
# (audit_queue_config.py). Performs ONE metadata GET against the queue
# /consumers endpoint. It never pulls, leases, acknowledges, retries, sends,
# or inspects messages.
set -euo pipefail
set +x  # explicitly disable shell tracing before any secret is sourced

# Resolve this script's directory so the launcher works from the repo root or
# the consumer directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE="$SCRIPT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. It is the gitignored runtime config" \
       "(see docs/runbooks/receipts-queue-control-plane.md)." >&2
  exit 2
fi

# Source the gitignored .env in THIS process so the verifier inherits the
# credentials via the environment. Values are never echoed and never placed in
# argv. No temporary credential files are created.
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

# The verifier is standard-library only; any python3 works. Prefer the
# consumer venv if present, else the system python3.
if [[ -x "$SCRIPT_DIR/.venv/bin/python3" ]]; then
  PY="$SCRIPT_DIR/.venv/bin/python3"
else
  PY="$(command -v python3 || true)"
fi
if [[ -z "$PY" ]]; then
  echo "ERROR: python3 not found on PATH." >&2
  exit 2
fi

exec "$PY" "$SCRIPT_DIR/audit_queue_config.py"
