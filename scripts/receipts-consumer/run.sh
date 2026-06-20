#!/usr/bin/env bash
# Wrapper for launchd / manual runs: load .env, then run the consumer.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PY="${PY:-.venv/bin/python3}"
exec "$PY" consumer.py "$@"
