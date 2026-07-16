# Receipts queue control-plane runbook

**Status: Current operator runbook.** Canonical operator procedure for the
receipts extraction-queue HTTP-pull consumer (ADR 0001).

## Where the configuration lives

HTTP pull consumers are **Cloudflare control-plane configuration**. By current
Cloudflare design they are configured through the dashboard, the Queues REST
API, or `wrangler queues consumer http`, and are **NOT supported in
`wrangler.jsonc`** (no `queues.consumers[]` block for HTTP pull; existing
`type: "http_pull"` in a Wrangler config file is no longer supported and should
be removed). The Worker holds only the **producer** binding (`RECEIPTS_QUEUE`
→ `dazbeez-receipts-extraction`).

The checked-in *expected* policy is the single source of truth:
`scripts/receipts-consumer/queue_policy.py`. This runbook mirrors it for humans.

## Policy table — expected HTTP-pull consumer

| setting | expected value |
|---|---|
| consumer type | `http_pull` |
| queue | `dazbeez-receipts-extraction` |
| dead-letter queue | `dazbeez-receipts-extraction-dlq` |
| `batch_size` | 10 |
| `max_retries` | 5 |
| `retry_delay` | 0 |
| `visibility_timeout_ms` | 43 200 000 (12 hours) |

The DLQ (`dazbeez-receipts-extraction-dlq`) has **no consumer**; messages that
exhaust `max_retries` land there for operator investigation.

## Runtime table — Mac MLX consumer

| behavior | value |
|---|---|
| Mac per-pull batch size | 10 |
| Mac per-pull visibility timeout | 5 minutes (300 000 ms) |
| Mac polling interval (empty/error sleep) | 20 seconds |
| launchd `StartInterval` | 600 seconds (10 minutes) |

**Per-pull override:** the Mac consumer sends `visibility_timeout_ms` and
`batch_size` in each `/messages/pull` body. The **5-minute per-pull value
overrides the 12-hour configured consumer default for the current Mac
consumer.** The 12-hour default therefore does not affect today's processing,
but it remains a risk for any future consumer that omits the per-pull override
— do not lower it without runtime evidence of model cold-start and full-batch
processing duration.

## Verifying the live configuration (read-only)

```bash
scripts/receipts-consumer/audit-queue-config.sh
```

This performs **exactly one metadata `GET` to the queue's `/consumers`
endpoint** and prints `field | expected | live | MATCH/DRIFT` for the seven
non-secret fields above. It **never** pulls, leases, acknowledges, retries,
sends, or inspects messages (no `/messages/*` call), and never prints the
token, account id, queue id, consumer id, or raw response.

Exit codes:

| code | meaning |
|---|---|
| 0 | every field matches the expected policy |
| 1 | drift, HTTP error, timeout, malformed response, or wrong consumer count/type |
| 2 | missing environment (`CF_ACCOUNT_ID` / `CF_QUEUE_ID` / `CF_API_TOKEN`), or no `.env` / `python3` |

### Drift procedure

If the verifier reports **any DRIFT, or exits nonzero, stop.** Do not change
live queue configuration from a code PR or an automated job. Obtain explicit
operator authorization, then reconcile via the control plane (dashboard or
`wrangler queues consumer http` — see provisioning below). Re-run the verifier
after any change.

> Do **not** use `wrangler queues message list` to verify configuration —
> listing messages can lease them and is not a read-only configuration check.

## First-time provisioning / disaster recovery

**Every command in this section is MUTATING. Do not run any of them for
verification — verification is `audit-queue-config.sh` only.** `queue create`
and `consumer http add/remove` are **not idempotent**: re-running them on
existing resources errors or has side effects. Provision the DLQ **before**
attaching the primary consumer, so the consumer can reference it.

```bash
# 1. Create the primary queue.   (MUTATING, not idempotent)
npx wrangler queues create dazbeez-receipts-extraction

# 2. Create the DLQ FIRST.        (MUTATING, not idempotent)
npx wrangler queues create dazbeez-receipts-extraction-dlq

# 3. Attach the HTTP pull consumer with the full intended policy.
#    (MUTATING, not idempotent — errors if a consumer already exists;
#     remove it first with `wrangler queues consumer http remove`.)
npx wrangler queues consumer http add dazbeez-receipts-extraction \
  --batch-size 10 \
  --message-retries 5 \
  --dead-letter-queue dazbeez-receipts-extraction-dlq \
  --visibility-timeout-secs 43200 \
  --retry-delay-secs 0
```

Then issue the Mac consumer's `CF_API_TOKEN` (scoped `queues_read` +
`queues_write`) and `RECEIPTS_PROCESSOR_KEY` (Worker secret) per
[receipts-extraction-rollout.md](receipts-extraction-rollout.md), and verify
with `audit-queue-config.sh` (expect seven MATCH rows, exit 0).

## Related

- [receipts-extraction-rollout.md](receipts-extraction-rollout.md) — end-to-end extraction rollout (ADR 0001).
- `scripts/receipts-consumer/queue_policy.py` — machine-readable expected policy.
- `docs/adr/0001-receipt-extraction-runtime.md` — store-and-forward extraction decision.
