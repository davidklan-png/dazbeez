"""Machine-readable authority for the receipts extraction-queue policy.

Single checked-in source of truth shared by:
  * audit_queue_config.py — the read-only drift verifier
  * consumer.py           — the Mac MLX consumer (runtime overrides)
  * docs/runbooks/receipts-queue-control-plane.md — the human runbook

The live Cloudflare HTTP-pull consumer is configured OUT OF BAND on the
control plane (dashboard / API / `wrangler queues consumer http`). HTTP pull is
NOT declarative in wrangler.jsonc by current Cloudflare design, so this module
is the canonical *expected* policy; the verifier checks the live control plane
against it.

Name convention:
  EXPECTED_CONSUMER_*  — the configured HTTP-consumer defaults (control plane).
  MAC_PER_PULL_*       — the Mac consumer's per-pull overrides, sent in each
                         /messages/pull body. These win over the defaults for
                         the current consumer.

Do not change a value here without also reconciling the live control-plane
configuration (an explicitly authorized operator procedure) and the runbook.
"""

# ─── Queue names ────────────────────────────────────────────────────────────
PRIMARY_QUEUE_NAME = "dazbeez-receipts-extraction"
DEAD_LETTER_QUEUE_NAME = "dazbeez-receipts-extraction-dlq"

# ─── Expected HTTP-pull consumer settings (control-plane configuration) ─────
# These are the values the live Cloudflare HTTP-pull consumer MUST hold. They
# are the configured consumer defaults, NOT the Mac per-pull overrides below.
EXPECTED_CONSUMER_TYPE = "http_pull"
EXPECTED_CONSUMER_BATCH_SIZE = 10
EXPECTED_CONSUMER_MAX_RETRIES = 5
EXPECTED_CONSUMER_RETRY_DELAY = 0
EXPECTED_CONSUMER_VISIBILITY_TIMEOUT_MS = 43_200_000  # 12 hours

# ─── Mac consumer per-pull runtime overrides ────────────────────────────────
# Sent in each /messages/pull request body; they override the consumer defaults
# above for THIS consumer. The 12-hour configured default remains a risk for
# any future consumer that omits these overrides.
MAC_PER_PULL_BATCH_SIZE = 10
MAC_PER_PULL_VISIBILITY_TIMEOUT_MS = 300_000  # 5 minutes
MAC_POLL_INTERVAL_S = 20
