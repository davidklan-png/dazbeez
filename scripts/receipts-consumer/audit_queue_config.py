#!/usr/bin/env python3
"""Read-only verifier for the receipts extraction-queue HTTP-pull consumer.

Checks the LIVE Cloudflare control-plane configuration against the checked-in
policy in queue_policy.py. It performs exactly ONE metadata GET to the queue's
/consumers endpoint and prints a field-by-field MATCH/DRIFT table.

It NEVER calls any /messages/* endpoint — no pull, lease, acknowledge, retry,
list, or send. Verification is metadata-only and does not touch messages.

Safety:
  * CF_API_TOKEN is read from the environment and sent only in the
    Authorization header. Its expanded value is never placed in argv.
  * Output is restricted to the seven non-secret policy fields. The token,
    account id, queue id, consumer id, raw response body, and response headers
    are never printed.
  * Exits 0 only when every expected field matches; nonzero for drift, missing
    environment, malformed response, unexpected consumer count/type, HTTP error,
    timeout, or JSON failure. Error output stays redacted (HTTP status is OK;
    response body is not).

Run via audit-queue-config.sh (which sources the gitignored .env), or directly
with CF_ACCOUNT_ID / CF_QUEUE_ID / CF_API_TOKEN already in the environment.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

from queue_policy import (
    DEAD_LETTER_QUEUE_NAME,
    EXPECTED_CONSUMER_BATCH_SIZE,
    EXPECTED_CONSUMER_MAX_RETRIES,
    EXPECTED_CONSUMER_RETRY_DELAY,
    EXPECTED_CONSUMER_TYPE,
    EXPECTED_CONSUMER_VISIBILITY_TIMEOUT_MS,
    PRIMARY_QUEUE_NAME,
)

NETWORK_TIMEOUT_S = 30
REQUIRED_ENV = ("CF_ACCOUNT_ID", "CF_QUEUE_ID", "CF_API_TOKEN")

# Ordered (label, expected) pairs. settings.* labels are read from the
# consumer's `settings` sub-object; the rest are read top-level. A missing key
# yields None, which is DRIFT (values are never silently defaulted).
FIELDS = [
    ("type", EXPECTED_CONSUMER_TYPE),
    ("queue_name", PRIMARY_QUEUE_NAME),
    ("dead_letter_queue", DEAD_LETTER_QUEUE_NAME),
    ("settings.batch_size", EXPECTED_CONSUMER_BATCH_SIZE),
    ("settings.max_retries", EXPECTED_CONSUMER_MAX_RETRIES),
    ("settings.retry_delay", EXPECTED_CONSUMER_RETRY_DELAY),
    ("settings.visibility_timeout_ms", EXPECTED_CONSUMER_VISIBILITY_TIMEOUT_MS),
]


def consumers_url(account_id: str, queue_id: str) -> str:
    """The read-only consumer-metadata endpoint (never a /messages/ path)."""
    return (
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
        f"/queues/{queue_id}/consumers"
    )


def live_for(consumer: dict, label: str):
    """Live value for a label, or None if absent (None => DRIFT). Pure."""
    if label.startswith("settings."):
        settings = consumer.get("settings")
        if not isinstance(settings, dict):
            return None
        return settings.get(label.split(".", 1)[1])
    return consumer.get(label)


def compare(consumer: dict):
    """Return [(label, expected, live, is_match), ...]. Pure."""
    rows = []
    for label, expected in FIELDS:
        live = live_for(consumer, label)
        rows.append((label, expected, live, live == expected))
    return rows


def format_table(rows) -> str:
    """Render 'field | expected | live | MATCH/DRIFT'. Pure.

    Prints only the seven policy fields — never identifiers, tokens, or the
    raw response."""
    lines = []
    for label, expected, live, is_match in rows:
        verdict = "MATCH" if is_match else "DRIFT"
        lines.append(f"{label} | {expected} | {live} | {verdict}")
    return "\n".join(lines)


def _fetch(url: str, token: str):
    """Perform the single GET. Returns (status, body_bytes). Network seam."""
    req = urllib.request.Request(
        url, headers={"Authorization": "Bearer " + token}
    )
    with urllib.request.urlopen(req, timeout=NETWORK_TIMEOUT_S) as resp:
        return resp.status, resp.read()


def run() -> int:
    missing = [k for k in REQUIRED_ENV if not os.environ.get(k)]
    if missing:
        print("ERROR: missing environment: " + ",".join(missing), file=sys.stderr)
        return 2

    url = consumers_url(os.environ["CF_ACCOUNT_ID"], os.environ["CF_QUEUE_ID"])
    token = os.environ["CF_API_TOKEN"]

    try:
        _status, body = _fetch(url, token)
    except urllib.error.HTTPError as e:
        print(f"ERROR: HTTP {e.code}", file=sys.stderr)
        return 1
    except TimeoutError:
        print("ERROR: network timeout", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        reason = type(e.reason).__name__ if e.reason is not None else "URLError"
        print(f"ERROR: network {reason}", file=sys.stderr)
        return 1

    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        print("ERROR: malformed JSON response", file=sys.stderr)
        return 1

    if not isinstance(data, dict) or not data.get("success"):
        print("ERROR: API success=false or malformed envelope", file=sys.stderr)
        return 1

    result = data.get("result")
    if not isinstance(result, list):
        print("ERROR: malformed result (not a list)", file=sys.stderr)
        return 1
    if len(result) == 0:
        print("ERROR: expected exactly 1 consumer, found 0", file=sys.stderr)
        return 1
    if len(result) > 1:
        print(f"ERROR: expected exactly 1 consumer, found {len(result)}", file=sys.stderr)
        return 1

    consumer = result[0]
    if not isinstance(consumer, dict):
        print("ERROR: malformed consumer object", file=sys.stderr)
        return 1

    rows = compare(consumer)
    print(format_table(rows))
    return 0 if all(is_match for *_unused, is_match in rows) else 1


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
