# Runbook — Receipts extraction rollout (ADR 0001)

Steps to take the store-and-forward extraction live. **All steps run on the Mac M4** with live Cloudflare credentials — the code is already on branch `feat/receipts-extraction-queue-mlx`. Do them in order; each is idempotent unless noted.

## 0. Prerequisites

- On the Mac, on the feature branch, with `wrangler` authenticated to the Dazbeez Cloudflare account.
- Apple Silicon with the 128 GB unified memory (for MLX).
- `python3` ≥ 3.10 and `pip`.

## 1. Create the Cloudflare Queue

```bash
npx wrangler queues create dazbeez-receipts-extraction
```

The producer binding (`RECEIPTS_QUEUE`) is already declared in `wrangler.jsonc`.

## 2. Create the HTTP pull consumer + API token

Pull consumers are not declared in `wrangler.jsonc`; create one and note its IDs:

```bash
# Register an HTTP pull consumer on the queue
npx wrangler queues consumer http add dazbeez-receipts-extraction
```

Then in the Cloudflare dashboard (or via API), create an **API token** scoped to
**Queues → Read** and **Queues → Write**. Record:

- `CF_ACCOUNT_ID` — your account id
- `CF_QUEUE_ID` — the queue id (`npx wrangler queues list` / dashboard)
- `CF_API_TOKEN` — the scoped token

## 3. Set the processor secret (Worker side)

The Mac consumer authenticates to the extract endpoint with a shared key:

```bash
# Generate a strong key, then:
npx wrangler secret put RECEIPTS_PROCESSOR_KEY
```

Use the same value in the consumer's `.env` (step 5).

> **If a Cloudflare Access *application* fronts `dazbeez.com/api/receipts*` at the edge**, the processor key alone won't get the consumer through — Access blocks the request before the Worker runs, so the dry run (step 7) returns an Access login page instead of `200`. In that case also create an **Access service token** (Zero Trust → Access → Service Auth), add a policy on the Access app that allows that service token, and set `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` in the consumer `.env`. The consumer sends them automatically when present. If Access only validates in-Worker (no edge application), you can skip this.

## 4. Apply the D1 migration

```bash
# Local first, then production
npx wrangler d1 migrations apply RECEIPTS_DB --local
npx wrangler d1 migrations apply RECEIPTS_DB
```

`0016_extraction_queue.sql` adds `extraction_state` etc. and backfills existing
rows to `processed` so they never block month-close as phantom pending work.

## 5. Set up the MLX consumer

```bash
cd scripts/receipts-consumer
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in the values from steps 2–3
```

First run pulls the model weights (a few GB) and caches them:

```bash
./run.sh --once             # processes one batch, then exits
```

To install the launchd agent (drain on login/wake + every 10 min):

```bash
cp com.dazbeez.receipts-consumer.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.dazbeez.receipts-consumer.plist
```

"Process queue" on demand = `./run.sh --once` (or `python3 consumer.py --once`).

## 6. Build + deploy the Worker

```bash
npm run build:cf            # must pass
npm run deploy
```

## 7. Smoke test

```bash
bash scripts/check-deployment.sh https://dazbeez.com
```

Then end-to-end:

1. Capture a receipt at `/receipts/capture`. It should land as **pending processing** (status `captured`), not `needs_review`.
2. Confirm the dashboard/reconcile "Receipts pending processing" tile shows it.
3. Run `./run.sh --once`. Within a batch the receipt should advance to **needs_review** with merchant/amount/date populated.
4. Try to finalize a month that has a pending capture in its window — finalize must return **409 "drain the queue"**. Drain, then finalize succeeds.

## 8. Decommission Google Vision (after the consumer is proven)

```bash
npx wrangler secret delete GOOGLE_CLOUD_VISION_API_KEY
```

The Vision provider in `lib/receipts/extraction.ts` is already marked
`@deprecated` and is no longer wired to any route; delete that dead code in a
follow-up PR once you're confident in the MLX path.

## Rollback

The change is store-and-forward over existing tables; nothing destructive.

- To pause processing: stop the consumer (`launchctl unload …`). Captures
  accumulate safely as `captured`; nothing is lost. Month-close is gated until
  you drain.
- To revert capture to synchronous review-ready behavior: redeploy the previous
  Worker. New captures will again land as `needs_review`. Already-queued
  messages can be drained or purged (`npx wrangler queues ...`). The `0016`
  columns are additive and harmless if unused.

## Phase 2 (separate work)

Swap the off-the-shelf VLM for the bespoke fine-tuned model. It drops into the
same `MLX_MODEL` slot. Gate the switch on the extraction-accuracy eval
(`docs/dashboards/slm-eval-dashboard.html`, `scripts/export-receipt-training-set.mjs`):
a model may only outrank the regex baseline per-field after beating it on a
held-out reconciled month.
