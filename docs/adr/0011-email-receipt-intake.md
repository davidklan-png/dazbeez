# ADR 0011 — Email receipt intake (receipts@dazbeez.com)

- **Status:** Accepted
- **Date:** 2026-07-19 (proposed) · 2026-07-19 (accepted, placement resolved)
- **Owner:** David (PM)
- **Supersedes:** —
- **Superseded by:** —
- **Related:** [ADR 0001](0001-receipt-extraction-runtime.md) (store-and-forward extraction runtime, which this feeds into), `lib/receipts/upload-policy.ts` header note ("no email/HTML ingestion pipeline exists," 2026-07-16), `lib/receipts/compliance.ts` (`ELECTRONIC_SOURCE_TYPES` already includes `email_attachment`), `workers/email-reply-capture/` (the standalone-worker precedent this ADR follows)
- **Affects:** new standalone Cloudflare Worker `workers/receipts-email-intake/` (email routing + cleanup cron — NOT the main `dazbeez` OpenNext worker), `db/receipts/0024_email_intake.sql` (new table, written), `lib/receipts/email-intake.ts` (new, written — placement-agnostic, takes injected `db`/`bucket`), `app/(receipt-system)/receipts/inbox/` (new review screen, written), `app/api/receipts/inbox/*` (new, written), `lib/receipts/db.ts` (`createReceiptRecord` — reused, not modified), `lib/receipts/audit.ts` (new `email_intake.*` actions, written)

## Decision record (2026-07-19)

**Worker report confirmed the predicted blocker.** The implementing agent
investigated §3 (email handler placement) and reported, correctly, that
`@opennextjs/cloudflare`'s `CloudflareOverrides` type has no `email` or
`scheduled` hook, and the generated `.open-next/worker.js` exports only
`fetch` — regenerated on every `build:cf`, so hand-editing it is not viable.
**Verified independently** (not taken on the report's word): read
`node_modules/@opennextjs/cloudflare/dist/api/config.d.ts` directly (confirms
the override surface is `incrementalCache | tagCache | queue | cachePurge |
enableCacheInterception | routePreloadingBehavior` — no email/scheduled), and
read the generated `.open-next/worker.js` directly (confirms `export default
{ async fetch(...) }` and nothing else).

**Resolved:**

1. **§3 placement — Option A, standalone worker, approved.** A new Cloudflare
   Worker, `workers/receipts-email-intake/`, mirroring the existing
   `workers/email-reply-capture/` precedent exactly (own `wrangler.jsonc`,
   own `name`, own `d1_databases`/`r2_buckets` bindings). Cloudflare Email
   Routing points `receipts@dazbeez.com` at this worker, not at `dazbeez`.
   It parses MIME (the `email-reply-capture` precedent already vets
   `postal-mime` for this — reuse it, do not re-evaluate MIME libraries) and
   calls the already-written, placement-agnostic `recordIntake(db, bucket,
   input)`.
2. **§6 cleanup cron — lives in the same standalone worker.** It already
   needs `RECEIPTS_DB`/`RECEIPTS_BUCKET` bindings for intake; carrying its
   own `[triggers].crons` for the 30-day stale-row cleanup is trivial there
   and was never viable in OpenNext regardless. Do not add scheduled-worker
   machinery to the main `dazbeez` worker for a receipts-only concern.
3. **30-day stale-triage window confirmed.** `INTAKE_STALE_DAYS = 30` (already
   coded in `lib/receipts/email-intake.ts`) stands as written; no change
   needed.

**Why a third worker (not folding into `email-reply-capture`):** conflates
two unrelated domains (CRM email replies vs. tax-record receipt intake)
behind one deploy/secret/monitoring surface. A separate worker costs one more
`wrangler.jsonc` and one more deploy step, and buys real isolation: a broken
`dazbeez` (Next.js/OpenNext) deploy cannot take down receipt-email intake,
and vice versa, and the two domains' secrets/bindings stay scoped to what
each actually needs. Consistent with the existing two-worker split already
in the repo, not a new pattern.

**Operational impact worth flagging (PM-relevant):** this is now a **third**
independently deployable Cloudflare Worker in the account (`dazbeez`,
`dazbeez-email-reply-capture`, and now `dazbeez-receipts-email-intake`).
Each is a separate thing that can be down, misconfigured, or silently
failing without the others noticing. `docs/receipt-module.md` and the deploy
runbook should get a line for it once built, and — per the "no
SLA/notification in scope for v1" negative consequence already called out
below — it's worth deciding later whether an unattended intake worker with
no monitoring is acceptable indefinitely or just for launch.

**New finding — SPF/DKIM verdicts may not be reliably available on the
Worker-delivery path.** Researched while resolving §3 (not something the
worker report or the original design surfaced). Per a known, currently open
Cloudflare issue (`cloudflare/workerd#6740`), Email Routing's "Send to a
Worker" delivery path does NOT reliably stamp an `Authentication-Results`
header on the message the way forwarding-to-an-address does — the
`ARC-Authentication-Results` header observed contains `arc=none` with no
`spf=`/`dkim=`/`dmarc=` verdict. This does not block anything — the ADR's
`spf_pass`/`dkim_pass` fields were always advisory ("not used to
auto-reject"), and mail is still accepted and processed regardless — but the
audit rationale of "the SPF/DKIM verdicts stay answerable" may be weaker in
practice than written if this Worker-delivery gap is still present when
built. The implementation prompt below directs the worker to verify this
empirically against a live test message and default `spf_pass`/`dkim_pass`
to `false` (not throw/guess) if the expected header is absent, rather than
silently reporting an inaccurate pass.

**§3/§6 build complete and independently verified (2026-07-19).**
`workers/receipts-email-intake/` is scaffolded, type-checks, and bundles
clean. Verified myself, not just from the report: `tsc --noEmit` clean in
both the worker and the root app; `wrangler deploy --dry-run` reproduces
the reported bundle (140.20 KiB / gzip 33.82 KiB) with the exact bindings
(`RECEIPTS_DB`, `RECEIPTS_BUCKET`, nothing else); grepping the emitted
bundle confirms zero occurrences of `getCloudflareContext` /
`createReceiptRecord` / `createAuditEntry` / `promoteIntake` /
`rejectIntake` (OpenNext/consumer-side code is correctly tree-shaken out)
and six occurrences of `recordIntake`/`classifyAttachment` (correctly
kept); root suite is 609 tests / 608 pass / 1 pre-existing skip (+19 new,
zero regressions), matching the report exactly.

**Fail-safe vs. fail-loud on intake failure — kept fail-safe, not a
policy toggle.** The report flagged a real trade-off: `email()` currently
logs-and-swallows failures rather than throwing, so a failed intake leaves
no trace beyond Worker logs. The suggested alternative — throw so
Cloudflare bounces the message back to the sender — does not actually
work as described under the current structure: `email()` calls
`ctx.waitUntil(processMessage(...))` and returns immediately, so
`processMessage`'s internal try/catch already runs *after* the handler
has resolved. Making failures throw there would surface as an unhandled
background rejection, not a bounce — achieving an actual bounce would
require awaiting `processMessage` synchronously inside `email()` instead
of backgrounding it, a real restructure, not a one-line change. Decision:
**do not make this change.** Two reasons beyond the structural one: a
bounce on a transient D1/R2 blip would reject legitimate mail for a
reason the sender can't fix, and bounce behavior is itself a small
information-disclosure surface on an unauthenticated endpoint (repeated
probing could fingerprint intake-worker internals from bounce timing/
content). Fail-safe stays. The residual risk — a failed intake is
invisible outside Worker logs — is accepted for v1, consistent with the
"no SLA/monitoring in scope for v1" trade-off already on record below;
revisit if real volume makes this worth a dashboard alert.

**Migration 0024 — applied live (David, prior turn).** Cannot be
independently confirmed from this sandboxed session (no live Cloudflare
API token available here — `wrangler d1 migrations list --remote` fails
with the expected non-interactive-auth error). Taken on David's word;
worth a `wrangler d1 migrations list RECEIPTS_DB --remote` spot-check on
the Mac before relying on it.

**Still required before this is live (unchanged from the worker's own
list):** first deploy of `dazbeez-receipts-email-intake`; the Cloudflare
Email Routing dashboard rule pointing `receipts@dazbeez.com` at it (see
the quick-instructions given separately); and a live-mail test to resolve
the still-open §0.3 question (whether `Authentication-Results` is
actually stamped on Worker-delivered mail) — `extractAuthVerdicts`/
`pickRawHeadersSubset` may need adjusting once real header shapes are
observed.
`db/receipts/0024_email_intake.sql` is written and matches this ADR exactly
(confirmed by direct read: no `retention_until`/`legal_hold` columns, 3-state
`status` CHECK, `promoted_receipt_id` FK). Per `AGENTS.md`, D1 migrations run
on the Mac against live bindings (`npx wrangler d1 migrations apply
RECEIPTS_DB --local` then, after verifying, without `--local` for
production) — this sandboxed session has no live Cloudflare credentials to
do that. **Action for David:** apply the migration on the Mac before the
`/receipts/inbox` screen or promote/reject APIs are exercised — they will
500 (`no such table: email_receipt_intake`) until then. Low risk to apply
early since the table has no callers yet (routes exist but nothing reachable
without the worker + Email Routing wired).

**Scope change (2026-07-19, operator action): three addresses now route to
this worker, not one.** `receipts@`, `receipt@`, and `billing@dazbeez.com`
are all wired in Cloudflare Email Routing to `dazbeez-receipts-email-intake`.
This ADR and title were written and built around a single address; the
system now needs to be evaluated against three.

Nothing about the trust model changes — the worker doesn't branch on
recipient address, so all three still land in the same undifferentiated
`pending_triage` queue under the same accept-any-sender-then-triage posture
already decided. But two real gaps follow directly from the address, not the
sender:

- **The intake pipeline doesn't record which address received the mail.**
  `message.to` is only read for a size-ceiling log line
  (`workers/receipts-email-intake/src/index.ts`); `recordIntake()` has no
  `toAddress` field, `email_receipt_intake` has no `to_address` column, and
  `/receipts/inbox` never surfaces it (the "to" header does end up buried in
  `raw_headers_json`, but nothing reads it back out). A human triaging today
  cannot tell, without opening dev tools, whether a given row arrived via
  `receipts@`, `receipt@`, or `billing@`.
- **`billing@` is a materially different address than `receipts@`.** A
  dedicated `receipts@`/`receipt@` alias mostly only gets what someone
  deliberately forwards there. `billing@` is a conventional address vendors
  and SaaS tools auto-CC on invoices, payment-failure notices, subscription
  changes, dunning emails, and account correspondence generally — not just
  receipts. Expect materially higher and noisier volume on that address, most
  of it without a promotable attachment, which dilutes the triage queue and
  makes "reject reason" entries much more common in normal operation, not the
  exception.

**Recommendation, not yet built:** add `to_address` as a first-class column
(`email_receipt_intake.to_address`, populated from `message.to` in the
worker) and surface it as a small badge/filter in `/receipts/inbox`, so the
mixed-address inbox stays triageable at volume rather than becoming an
undifferentiated pile. Low-cost, additive migration (new column, nullable,
no CHECK needed). Also update the now-inaccurate inbox header copy, which
still says "Receipts emailed to receipts@dazbeez.com" — fixed directly in
this pass (see below) since it's a one-line static string, not logic.

**Resolved 2026-07-19: `billing@` removed.** David pulled it back out of
Email Routing — it may serve other purposes and shouldn't feed this
pipeline unreviewed. **Final address set: `receipts@` and `receipt@`
dazbeez.com only**, both routed to `dazbeez-receipts-email-intake`. `receipt@`
exists purely as misspelling-tolerance for `receipts@`, not a distinct
purpose — unlike the `billing@` case, these two addresses have the same
intent and the same expected sender population, so the "noisier/different
mail" concern above no longer applies. The `to_address` visibility gap is
now a smaller, lower-urgency issue (nice-to-have for audit trail — "which
spelling did they use" — not noise triage), but it's cheap enough that it's
still worth building; see `prompts/WORKER-PROMPT-email-intake-to-address.md`.

## Context

`receipts@dazbeez.com` already exists as an *outbound* address (`NOTIFY_FROM_ADDRESS`, Resend). There is no inbound pipeline. `dazbeez.com` is a Cloudflare zone, and the receipts module already runs entirely on Cloudflare primitives (D1, R2, Queues) with a deliberate architecture from ADR 0001: **capture is always-on Cloudflare, processing is Mac-only, images never leave our estate.** The compliance layer (`lib/receipts/compliance.ts`) already anticipates this feature — `SourceType` includes `email_attachment`, and it's already classified as an `ELECTRONIC_SOURCE_TYPES` member, meaning Japan's electronic-bookkeeping preservation rules (original digital file preserved as-is, not a screenshot proxy) already apply to it in the compliance engine. The upload-policy header explicitly notes email ingestion doesn't exist yet ("no email/HTML ingestion pipeline exists" — as of 2026-07-16).

Three decisions were made with the operator (2026-07-19) before design:

1. **Ingestion mechanism:** Cloudflare Email Routing, not a third-party inbound-email API. No new vendor; the domain is already on Cloudflare; the Worker gets a native `email()` handler.
2. **Sender trust:** accept mail from any sender, but nothing an unauthenticated sender sends becomes a real receipt record automatically. It lands in a distinct **triage** state a human must promote.
3. **v1 scope:** attachments only (PDF/image, same types the capture form already accepts). Body-only receipts (HTML/plain-text vendor emails with no attachment, e.g. Uber/Amazon) are out of scope for v1.

This is a genuine expansion of the trust boundary. Every other write path into `receipt_records` is authenticated: Clerk session, `RECEIPTS_PROCESSOR_KEY` (Mac consumer), Queues API token, or a trusted-device bearer (`lib/receipts/trusted-devices.ts`). `receipts@dazbeez.com` becomes the first **unauthenticated, internet-facing** entry point into a system that carries 10-year legal-hold tax records.

## Decision

### Ingestion: Cloudflare Email Routing → Worker `email()` handler

Add an inbound route for `receipts@dazbeez.com` in Cloudflare Email Routing pointing at the `dazbeez` Worker. The Worker exports an `email(message, env, ctx)` handler alongside the existing `fetch` handler. It parses the MIME message (attachments + headers only — no body rendering in v1), extracts SPF/DKIM/DMARC verdicts Cloudflare already attaches to the message, and hands attachments to the intake path below. No new vendor, no new secret, no new webhook to authenticate — the trust boundary is `dazbeez.com`'s own DNS/MX.

### Intake lands in a new table, not `receipt_records`

Unauthenticated mail does **not** write into `receipt_records` directly. It writes into a new `email_receipt_intake` table:

```sql
CREATE TABLE IF NOT EXISTS email_receipt_intake (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  from_address TEXT NOT NULL,
  subject TEXT,
  spf_pass INTEGER NOT NULL DEFAULT 0,
  dkim_pass INTEGER NOT NULL DEFAULT 0,
  attachment_r2_key TEXT,
  attachment_sha256 TEXT,
  attachment_content_type TEXT,
  attachment_size_bytes INTEGER,
  attachment_filename TEXT,
  status TEXT NOT NULL DEFAULT 'pending_triage'
    CHECK (status IN ('pending_triage','promoted','rejected')),
  reject_reason TEXT,
  promoted_receipt_id TEXT REFERENCES receipt_records(id),
  raw_headers_json TEXT,
  created_at TEXT NOT NULL
);
```

Rationale for a separate table rather than inserting at `status='captured'` with a new "unverified" flag on `receipt_records`:

- **Nothing unreviewed touches the extraction queue or month-close.** ADR 0001 already made "pending processing" a hard gate on month-close (`finalize` returns 409 while the queue holds anything for the window). If arbitrary inbound mail could land in `receipt_records` at `status='captured'`, spam or a wrong-address forward would silently become a month-close blocker or consume a Mac MLX processing slot. A separate table means the extraction queue and month-close gate are structurally untouched by anything a human hasn't looked at.
- **Retention/legal-hold doesn't fire on unreviewed junk.** `receipt_records` inserts always carry `legal_hold=1` and a 10-year `retention_until` (`retentionUntilIso`). That posture is correct for real receipts, wrong for a misdirected spam attachment. The intake table carries no such metadata; only promotion creates a retained record.
- **One promotion path, reusing everything.** Promoting an intake row calls the *existing* `createReceiptRecord()` with `source: "email"`, `sourceType: "email_attachment"`, `status: "captured"` — the exact same insert mobile/desktop capture already uses, which already seeds `extraction_state='captured'` and is picked up by the existing enqueue-and-Mac-MLX pipeline unchanged. `paymentPath`/`expenseType` default to `"UNKNOWN"` (already-supported values) since email intake never carries them. No parallel extraction, review, reconciliation, or export logic is written.

### Review surface: `/receipts/inbox`

A new lightweight screen, not the existing `/receipts/review` queue (that queue's semantics — locks, month-scoping, reconciliation status — don't apply to unreviewed mail). Lists `email_receipt_intake` rows at `status='pending_triage'`, shows sender, SPF/DKIM verdicts, subject, and an attachment preview. Two actions per row:

- **Promote** → calls `createReceiptRecord` as above, sets `promoted_receipt_id`, `status='promoted'`. The resulting receipt then flows through the normal review queue exactly like a mobile capture.
- **Reject** → `status='rejected'` with a required `reject_reason`. The R2 object is retained for a short audit window (30 days, not 10 years) then deleted by a scheduled cleanup — this is not a tax record.

Every promote/reject is audit-logged (`lib/receipts/audit.ts`) with the SPF/DKIM verdicts preserved, so "who let this in" is always answerable even though the sender itself is unauthenticated.

### Validation reused, not reinvented

Attachments are validated against the exact same `ALLOWED_RECEIPT_MIME_TYPES` / `ALLOWED_RECEIPT_EXTENSIONS` / `MAX_RECEIPT_FILE_BYTES` (5 MiB) constants in `lib/receipts/upload-policy.ts` that already gate mobile/desktop capture. An email with no attachment, an unsupported attachment type, or an attachment over 5 MiB is still recorded in `email_receipt_intake` (so nothing silently vanishes) but flagged and cannot be promoted until resolved — it shows in the inbox as a rejected/needs-attention row with the reason, never as a phantom receipt.

### Explicit non-decisions (v1)

- **No body-only parsing.** An email with a receipt in the HTML/text body and no attachment is recorded (subject/sender visible in the inbox) but has nothing to promote. Revisit as a separate ADR if this shows up often enough to matter — it requires a body→PDF rendering step this ADR deliberately excludes.
- **No allow-list enforcement at the mail layer.** SPF/DKIM verdicts are captured and surfaced for the human triaging, not used to auto-reject. If spam volume becomes a real problem, add Cloudflare Email Routing rules (or a from-address allow-list before intake) as a follow-up — cheap to add later, doesn't need to block v1.
- **No auto-matching of duplicate receipts at intake.** `attachment_sha256` is captured on every intake row so a future pass can flag "this was already captured via mobile" before promotion, but that comparison is not built in v1.

## Consequences

### Positive

- Reuses 100% of the existing capture → queue → Mac MLX extraction → review → reconciliation → export pipeline. The only new code is: MIME parsing in the Worker, one new table, one new review screen, one promotion call into code that already exists.
- The trust-boundary expansion is contained to a table with no compliance weight (no legal hold, no month-close interaction, no retention) until a human explicitly promotes a row — the "accept any sender" decision doesn't mean "accept any sender into the books."
- Matches the compliance model already encoded in `compliance.ts` (`email_attachment` as an electronic source type) — this ADR is filling in a pipeline the schema was already designed to expect.

### Negative / accepted trade-offs

- New unauthenticated surface, full stop. Even with everything staged in a low-weight table, `receipts@dazbeez.com` can now receive attacker-controlled files (malformed PDFs, zip bombs disguised with a spoofed content-type, etc.) that a Worker must parse. MIME parsing must be defensive: hard size ceiling before parsing (reject anything over, say, 10 MiB at the Worker before it touches R2, independent of the 5 MiB receipt limit checked after), no execution of any parsed content, R2 write only after the size/type check passes.
- A second inbox to check. If nobody looks at `/receipts/inbox`, forwarded receipts sit unpromoted indefinitely. No SLA/notification is in scope for v1 — worth a follow-up (e.g. a daily count in the existing notify email) if this becomes the primary capture path rather than a convenience one.
- `email_receipt_intake` is a second place receipt-shaped data can live, which is one more thing a future schema change has to remember exists. Kept deliberately thin (no business fields — payment path, expense type, attendees — all of that only exists after promotion) to minimize the surface that can drift from `receipt_records`.

## Alternatives considered

- **Insert directly into `receipt_records` at a new `status='unverified'`.** Rejected: entangles an untrusted write path with the month-close gate and the 10-year retention/legal-hold defaults that every other insert path correctly assumes. Would require threading "is this verified" through the extraction queue, the review queue, and every reconciliation/export query that currently just trusts `receipt_records` — a much larger and riskier change for the same outcome.
- **Third-party inbound-email API (Postmark/SendGrid/Mailgun) instead of Cloudflare Email Routing.** Rejected per operator decision: adds a vendor, a webhook secret to manage, and a third party that sees attachment content in transit, for no capability Cloudflare Email Routing doesn't already provide given the domain is already on Cloudflare.
- **Allow-list senders at the mail layer before intake.** Considered and set aside, not rejected — operator chose accept-any + triage for v1 to keep the address usable for ad hoc forwarding (e.g. forwarding a vendor's emailed invoice) without needing every possible sender pre-registered. Revisit if spam/junk volume makes triage noisy.

## Implementation notes (non-binding)

1. Cloudflare dashboard / `wrangler` — add `receipts@dazbeez.com` as an Email Routing destination pointed at the `dazbeez` Worker (out-of-band control-plane config, same posture as the Queues HTTP pull consumer in ADR 0001 — not declarative in `wrangler.jsonc`).
2. Worker `email()` handler: parse MIME, extract SPF/DKIM verdicts Cloudflare provides on the message, extract attachments only (ignore body in v1), enforce a hard pre-parse size ceiling.
3. New migration `db/receipts/00NN_email_intake.sql` (next free number after 0023) for `email_receipt_intake`.
4. `lib/receipts/email-intake.ts`: insert intake rows, validate attachments against the existing `upload-policy.ts` constants, promote/reject actions (promote calls `createReceiptRecord`).
5. `/receipts/inbox` page + `app/api/receipts/inbox/*` routes, Clerk-gated like every other `/receipts/*` route.
6. Audit log entries for promote/reject via existing `lib/receipts/audit.ts`.
7. Scheduled cleanup (cron trigger or piggyback on an existing scheduled job) to delete rejected/unpromoted-and-stale intake R2 objects after 30 days.

## Open questions

- ~~Placement of the `email()` handler.~~ **Resolved 2026-07-19:** standalone worker (see Decision record above).
- ~~Retention window for unpromoted `pending_triage` rows.~~ **Resolved 2026-07-19:** 30 days, as coded (`INTAKE_STALE_DAYS`).
- Whether to add a low-noise notification (e.g. folded into the existing Resend notify email) when the inbox has unpromoted items, and at what age. Still open.
- Whether SPF/DKIM failure should downgrade an attachment to "visible but not promotable" rather than just an informational flag, once real spam volume is observed. Still open.
- Whether an unattended third worker (no monitoring/alerting) is acceptable long-term or just for launch — flagged in the Decision record's operational-impact note.

## Follow-up decision (2026-07-22): sender controls — blocklist, prospective trust, blocked-delivery metadata

### Context

The Phase B auto-promote allowlist (`trusted_intake_senders`, managed from Settings) lets a trusted sender's body-only emails auto-file with no human review. The operator requested visibility into unrecognized senders, the ability to block senders, and prospective trust (trusting a sender should not retroactively promote old pending mail).

### Decisions

1. **Operator-managed blocklist.** A new `blocked_intake_senders` table (migration `0034`) mirrors `trusted_intake_senders`. Trusted and blocked are mutually exclusive (trusting removes a blocked row; blocking removes a trusted row). Blocked wins defensively if inconsistent data exists.

2. **Prospective trust.** Auto-promotion now requires `intake.received_at >= trusted_sender.created_at`. Mail received before the sender was trusted stays `pending_triage` (an explicit human Promote still works). This also scopes the consumer's previously unbounded replay of ALL pending rows.

3. **Metadata-only blocked delivery.** Future mail from blocked senders is recorded as ONE minimal `rejected` row (`reject_reason='blocked_sender'`) with only sender, recipient, received time, SPF/DKIM, and a bounded subject — no raw headers, body, attachment, or R2 object. The block check runs in the Email Worker BEFORE reading `message.raw`, so attacker-controlled MIME is never parsed for blocked senders. If the blocklist lookup fails, the Worker logs visibly and continues into ordinary pending triage (the promotion gate is the final safety net).

4. **Defense in depth (intake + promotion).** Block enforcement happens in three layers: (a) the Email Worker (before reading raw), (b) the Python auto-promote consumer, and (c) authoritatively in the processor-key promotion route (`POST /api/receipts/inbox/[id]/promote`) immediately before promotion. The route re-reads the intake + current sender policy and returns 409 if the intake fails prospective auto-promotion policy. This closes the race where a sender is blocked between the consumer's selection and the promotion call.

5. **Explicit human Promote override.** A Clerk-authenticated human Promote is NOT gated by the auto-promotion policy — it remains an explicit override for any promotable message, even if the sender is now blocked (decision 10).

6. **Inbox block action rejects only the selected row.** Blocking from an Inbox row blocks the sender AND rejects that ONE intake row. Other pending rows from the same sender are NOT mass-rejected (decision 11).
