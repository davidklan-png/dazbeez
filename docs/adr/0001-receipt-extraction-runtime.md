# ADR 0001 — Receipt extraction runtime: Cloudflare capture/buffer + Mac-only processing

- **Status:** Proposed
- **Date:** 2026-06-09
- **Owner:** David (PM)
- **Affects:** `app/api/receipts/*`, `lib/receipts/*`, `app/(receipt-system)/receipts/*`, `wrangler.jsonc`, `db/receipts/*`

## Context

Receipt field extraction today runs **synchronously and inline**. The `POST /api/receipts/[id]/extract` route calls Google Cloud Vision for OCR, then `lib/receipts/extraction.ts` applies deterministic regex/heuristics to populate `merchant`, `transaction_date`, `amount_minor`, `currency`, and `expense_type`. The request blocks on Vision returning, and receipt images leave our estate to a third-party API.

Three goals are driving a change:

1. **Use the M4 Max (128 GB).** The processing machine can now run large local vision-language models and fine-tune our own — not just call a hosted API.
2. **Survive the Mac being offline.** Receipts are captured in the field, away from the office; processing happens later at the desk. Work captured while the Mac is off must persist and be processed when it returns.
3. **Build a bespoke SLM.** We want to own the extraction model and improve it on our own receipt corpus.

The operating model the team agreed on: **Cloudflare holds captured work durably; the Mac is the only thing that processes the queue, when it is online.** This is store-and-forward (batch), not high-availability failover. The Mac is the single inference engine.

## Decision

Split extraction into a **capture path** (always-on, Cloudflare) and a **processing path** (Mac-only), connected by a **durable Cloudflare Queue** that the Mac drains on its own schedule.

### Capture path (Cloudflare, always available)

Field capture writes the image to R2 (`RECEIPTS_BUCKET`, key in `receipt_records.original_r2_key`), inserts the `receipt_records` row at `status = 'captured'`, and enqueues an extraction job. No AI runs here. The existing mobile capture/pairing/trusted-device machinery (`lib/receipts/mobile-upload.ts`, `mobile-pairing.ts`, `trusted-devices.ts`) already covers away-from-office capture; the only addition is the enqueue.

### Buffer (Cloudflare Queues, pull consumer)

A Cloudflare Queue with an **HTTP pull-based consumer** holds extraction jobs. Pull consumers are designed for exactly this case — a consumer outside Cloudflare that pulls only when ready — with lease/acknowledge semantics and a `visibility_timeout` of up to 12 hours. If the Mac dies mid-batch, unacknowledged jobs return to the queue automatically. Captured work is durable in Cloudflare regardless of Mac state.

### Processing path (Mac only)

When the Mac comes online it runs a consumer that pulls a batch, fetches each image from R2, runs the **local bespoke model** (vision-language model via Apple MLX), writes results back to D1/R2 over the live bindings the Mac already owns, advances the receipt to `needs_review`/`reviewed`, and acknowledges the jobs. The Mac is the single source of truth for bindings (per `AGENTS.md`), so no new credential surface is introduced.

Because there is **no cloud inference**, there is no second model to keep in sync. The local model can be arbitrarily large and bespoke; nothing forces it to also run at the edge.

## The reconciliation / month-close rule

Month-lock is **reconciliation completeness against the AMEX statement**: every `amex_statement_lines` row for the statement period must have a matching receipt or an equivalent confirmation before the period can be signed off (`reconciliation-signoff.ts`, `AmexReconciliationStatus: draft → finalized`).

Store-and-forward introduces a third state into the blocker logic. The matching key (merchant / amount / date) only exists **after** the Mac has extracted a receipt, so a captured-but-unprocessed receipt cannot be matched yet. Blocker logic must therefore distinguish:

- **Matched** — receipt extracted and reconciled to the statement line (`amex_statement_lines.receipt_status = 'matched'`). OK.
- **Pending processing** — a receipt exists (`receipt_records.status = 'captured'`) but is still in the queue, unextracted, and has no key to match on. **Not** a genuine missing-receipt blocker, but it **does** block close.
- **Genuinely missing** — no receipt and no equivalent confirmation anywhere (`receipt_status = 'missing_receipt'` with no `no_receipt_required` / `receipt_not_available` justification). The real blocker to chase.

**Enforced precondition:** a statement period cannot be finalized while the queue holds any unprocessed receipt for that window. "Drain the queue before close" is a hard gate, not advice. Without the *pending processing* state, a queue backlog masquerades as missing receipts and someone chases receipts we already hold.

The manual "equivalent confirmation" path (`no_receipt_required` / `receipt_not_available`) never touches the queue or the model, so those lines are always immediately matchable — unchanged by this ADR.

## Consequences

### Positive

- **Removes Google Cloud Vision.** Images are captured to our own R2 and processed only on our Mac — they never leave our estate. For a module handling financial PII this is a governance upgrade, and it drops the `GOOGLE_CLOUD_VISION_API_KEY` secret and its per-call cost.
- **No dev/prod model divergence.** One inference engine. The portability constraint that would apply if Cloudflare also ran inference (Workers AI only accepts LoRA adapters on a fixed set of *text* base models, no custom vision models) simply does not apply.
- **Captured work is durable independent of Mac uptime.** Field capture and storage are Cloudflare's responsibility; only processing depends on the Mac.
- **The bespoke-SLM goal is unconstrained.** Model size and architecture are limited only by the 128 GB machine.

### Negative / accepted trade-offs

- **Processing throughput is bounded by Mac uptime.** A receipt stays `captured` (visible as "pending processing") until the Mac runs. This is the intended batch behavior, but the review/reconcile UI must show *pending processing* as a first-class state, not an error or a missing receipt.
- **Month close gains a hard dependency on an empty queue** for the period. Operationally, close cannot happen until the Mac has drained that window.
- **Single processing point of failure.** If the Mac is gone for an extended period, the backlog grows (nothing is lost). If unattended processing ever becomes a requirement, revisit a Workers-AI cloud consumer as a *separate* future ADR.

### Migration risk

The synchronous → asynchronous change is the largest engineering item and touches UX. Keep the existing regex extractor as a **post-model validation guardrail / fallback**, not deleted — it catches a model confidently misreading an amount, which matters for a compliance module with month-locking and audit logging.

## Alternatives considered

- **Cloud inference fallback (Mac primary, Workers AI when Mac is down).** Rejected: contradicts the agreed batch model, forces model portability onto a constrained Workers-AI base-model list, and creates dev/prod divergence.
- **Plain D1 worklist (`SELECT … WHERE status='captured'`) instead of Queues.** Viable and uses an existing column, but we would hand-roll leasing, retries, and crash recovery. Queues provides those semantics for compliance data where "processed exactly once, nothing silently dropped" matters. D1 `status` remains the user-facing mirror of queue state.

## Implementation notes (non-binding)

1. Add a Cloudflare Queue + HTTP pull consumer; create an API token scoped to `queues_read` + `queues_write`.
2. Enqueue on capture; set/keep `receipt_records.status = 'captured'` as the "pending processing" marker.
3. Mac-side consumer: pull batch → R2 get → MLX model → D1/R2 write → status advance → ack. Trigger on network-up (launchd) and/or a manual "Process queue" action.
4. Reconciliation/blocker logic: add the *pending processing* state and gate `finalize` on a clear queue for the period.
5. Keep regex extraction as a validation layer over model output.
6. Stand up a field-level accuracy eval (held-out reconciled month) before letting any model outrank the regex baseline.

## Open questions

- Trigger policy for the Mac consumer: automatic on network-up, scheduled, manual, or a mix?
- Do we batch-notify the field user when their captured receipts finish processing?
- Eval threshold a model must beat before it is trusted over regex for a given field.
