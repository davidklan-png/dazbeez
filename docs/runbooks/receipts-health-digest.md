# Operator receipt-health digest — prepared, NOT activated

This change prepares a daily **always-send heartbeat**, proposed for **08:30 JST**
(`30 23 * * *` UTC, the preceding UTC date). Recipient, time, and policy confirmation
are pending. The checked-in intake-worker config has `DIGEST_ENABLED="false"`
and **no `DIGEST_TO`**. Missing recipient disables sending even if enabled. There
is no fallback to accountant settings, `ACCOUNTANT_EMAIL`, or a guessed operator.
No provider probe, email, deploy, secret change, or production mutation is part of
preparation. Main CI deploys the OpenNext app only, **not this sideworker**.

The existing `dazbeez-receipts-email-intake` worker runs the digest independently
of the Mac. Its original `0 3 * * *` UTC intake cleanup is unchanged. The handler
branches on the exact cron expression; an unknown expression rejects without
running either task. Email intake behavior is unchanged.

## Content and truth boundaries

Plain text includes the six canonical pipeline attention classes (error before
warning), uncapped per-class counts/oldest ages, and the oldest **5 filenames per
class** with signed-in review links. The cap and overlapping-class counts are
explicit. Failure reasons are reduced to safe categories; raw exception text,
extraction documents, provider errors, secrets, and email bodies are never sent.
Long filenames are capped at 120 characters and control characters removed.

Missing statements use the same three expected months/ready-date calculation as
the dashboard and the same artifact eligibility (`failed`/`replaced` excluded).
The shared calendar helper anchors on day 1 before subtraction, including at
month ends/year boundaries. Digest checks are global and ignore actor dismissals.
Delivery action uses the dashboard's latest **finalized revision**, then the
canonical attempt-history state machine. Never-attempted, failed, ambiguous, and
pending deliveries need attention; an earlier revision's successful delivery
cannot clear a newer revision. The denormalized delivery column is not trusted.

All-clear requires every query to succeed. Missing aggregates/results, failed
queries, missing details, and count/detail disagreement produce **DATA
UNAVAILABLE**, never all-clear. Independent successful sections remain visible.
A data-unavailable email is still attempted so the operator sees the diagnostic.
The snapshot consists of separate reads, not a transaction; counts can change
while it is collected and that disagreement is explicitly unavailable.

## Outcomes, retries, and monitoring limits

Structured `receipts_health_digest` logs contain only status and a safe reason:

- `disabled`: successful no-op, no D1 queries or fetch; explains missing recipient.
- `misconfigured`: missing per-worker provider key/from address or invalid recipient;
  no send, scheduled work rejects.
- `send_failed`: provider acceptance unconfirmed (may be ambiguous); scheduled
  work rejects. Never described as sent or delivered.
- `accepted`: provider returned success; does **not** prove inbox delivery. A
  `dataUnavailable=true` email also rejects scheduled work after logging so Cron
  Past Events records the incomplete health check.

The scheduled promise is attached with `ctx.waitUntil`. There is no application
retry loop or new D1 dedup table. The Resend key is ASCII and stable for the
scheduled **JST day + normalized recipient + receipt-health-v1 scope**. Resend
keeps keys for 24 hours. Identical retries replay; if the snapshot/config changes
under the same key, Resend can reject the changed payload (409), which is logged
as unconfirmed acceptance. Beyond 24 hours a replay can duplicate the harmless
digest. Changing recipient creates a new key. Do not treat this as exactly-once.
[Resend idempotency documentation](https://resend.com/docs/dashboard/emails/idempotency-keys).

A missing heartbeat is **not independently monitored**. Inspect Worker Logs and
Cron Past Events for missed/failed events; there is no separate digest-outage
alarm. Existing cleanup retains its original best-effort per-row behavior.

## Offline verification (no live email or bindings)

From repo root, under Node 22 (`fnm exec --using 22` on this Mac):

```sh
npm ci
npm --prefix workers/receipts-email-intake ci
npx tsx --test tests/receipts/pipeline-digest.test.ts
npm test
npm run lint
npx next typegen
npx tsc --noEmit
npx tsc --noEmit -p workers/receipts-email-intake/tsconfig.json
```

Also run `npm run build:cf` under Node 22. The existing main Next initializer
requests a remote AI dev proxy by default; for offline preparation force
`getPlatformProxy`'s `remoteBindings:false` in an external verification preload,
without changing tracked main config. Record that preload and the exact build
command with the verification logs. A local-only build is not live verification.

From `workers/receipts-email-intake`:

```sh
../../node_modules/.bin/tsx --test 'test/*.test.ts'
npx wrangler types src/intake-bindings.d.ts --config wrangler.jsonc --env-interface IntakeBindings --include-runtime=false --strict-vars=false
npx wrangler deploy --config wrangler.jsonc --dry-run --outdir /tmp/receipts-digest-bundle --metafile
```

Inspect the output binding list: **intake worker**, `DIGEST_ENABLED=false`, no
`DIGEST_TO`, and only its D1/R2 bindings. Inspect bundle metadata/source for absence
of `getCloudflareContext`, `cloudflare-runtime`, and OpenNext/Next runtime modules.
A dry run proves packaging, not a successful live query or email. All provider
fetches in tests are injected/mocked; SQL tests use in-memory SQLite with the
repository's migrations, not remote D1. No main-worker scheduled-hook workaround.

## Activation — requires a separate approved operator action

1. Confirm the operator recipient, time, and always-send versus attention-only
   policy. The implemented default is **always-send/08:30 JST**. Any policy/time
   change must update code/config and handler tests together. Never substitute
   the accountant recipient.
2. Configure `RESEND_API_KEY` on **dazbeez-receipts-email-intake**, separately from
   the main worker's secret; the main worker's key is not inherited. Confirm the
   verified sending domain matches `NOTIFY_FROM_ADDRESS`. Under the separately
   authorized activation, from the sideworker directory, the relevant command is
   `npx wrangler secret put RESEND_API_KEY --config wrangler.jsonc`. This changes
   live worker configuration and was **not run during preparation**.
3. Set the confirmed single-mailbox `DIGEST_TO` and `DIGEST_ENABLED="true"` in
   the sideworker config. Re-run offline tests/dry-run and inspect config diff.
4. Deploy the sideworker manually from its directory with
   `npx wrangler deploy --config wrangler.jsonc`. Do not assume main-app CI did it.
5. Verify both deployed cron expressions in Cloudflare Cron Triggers and compute
   the next occurrence of **23:30 UTC / next-day 08:30 JST**. Account for trigger
   propagation (Cloudflare documents up to 15 minutes). Confirm the next actual
   digest event in Cron Past Events/Worker Logs, provider acceptance, and the
   operator's received message against the signed-in dashboard. Do not invoke a
   live test/probe/send as part of this preparation task.
6. Disable by setting `DIGEST_ENABLED="false"` and deploying the sideworker;
   retain the cleanup cron. Unsetting `DIGEST_TO` also fails closed.

[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
uses UTC. A local `cf:dev` session is not proof of live D1 health or delivery.
