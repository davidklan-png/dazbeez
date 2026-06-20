# Decision Brief — ADR 0001: Receipt Extraction Runtime

- **For:** David (PM / owner)
- **Date:** 2026-06-20
- **Decision requested:** Approve moving receipt field-extraction from synchronous, in-Worker Google Cloud Vision to **store-and-forward**: Cloudflare captures and buffers work durably; the Mac M4 is the only thing that processes it, running a **bespoke local model (Apple MLX)**.
- **Status after this brief:** **Approved.** See ADR 0001 (Accepted) and the resolved open questions below.

## The decision in one paragraph

Today, extracting merchant/date/amount/tax from a receipt runs inside the Cloudflare Worker: it calls Google Cloud Vision, blocks on the response, and sends receipt images (financial PII) to a third party. We are splitting this into a **capture path** that always works (image → R2, row → `captured`, job → a durable Cloudflare Queue) and a **processing path** that only the Mac runs (pull a batch, OCR/extract locally with MLX, write results back, advance the receipt to review). Nothing infers in the cloud anymore. Captured work survives the Mac being offline; it simply waits in the queue until the Mac drains it.

## Why now

Three drivers, all already true:

1. **We have the hardware.** The M4 Max (128 GB) can run a large local vision-language model — we no longer need a hosted API to read a receipt.
2. **Capture happens in the field; processing happens at the desk.** The two are already separated in time. Receipts captured while the Mac is off must persist and process later. A durable queue is the honest expression of how the work already flows.
3. **We want to own the model.** A bespoke model trained on our own receipt corpus is the long-term accuracy and cost play. Owning extraction end-to-end is impossible while a third-party API sits in the path.

## What we gain

- **PII stops leaving our estate.** Images are captured to our own R2 and read only on our Mac. For a module that handles financial records under a 10-year retention/legal-hold posture, this is the single biggest reason to do it. It also drops the `GOOGLE_CLOUD_VISION_API_KEY` secret and its per-call cost.
- **One inference engine, no dev/prod model drift.** Because nothing runs at the edge, we are not constrained by Workers-AI's fixed base-model list, and there is no second model to keep in sync.
- **Captured work is durable regardless of Mac uptime.** Field capture and storage are Cloudflare's job; only processing depends on the Mac. Nothing is ever lost — at worst it waits.
- **The bespoke-model ambition is unconstrained.** Model size and architecture are limited only by the 128 GB machine, not by anything we can run in a Worker.

## What we accept (and how we contain it)

- **Throughput is bounded by Mac uptime.** A receipt sits in `captured` ("pending processing") until the Mac runs. *Containment:* the review/reconcile UI shows **pending processing as a first-class state**, never as an error or a missing receipt, and the Mac can drain on demand (a "Process queue" action) as well as automatically on network-up.
- **Month-close gains a hard dependency on an empty queue.** A statement period **cannot be finalized** while any receipt for that window is still unprocessed. *Containment:* this is enforced in code as a hard gate ("drain the queue before close"), with a clear blocker tile — not left to memory. This is the right behavior: without it, a queue backlog masquerades as missing receipts and someone chases receipts we already hold.
- **Single processing point of failure.** If the Mac is gone for a long stretch, the backlog grows (nothing is lost). *Containment:* accepted for now; if unattended processing ever becomes a requirement, we revisit a cloud consumer as a **separate future ADR** — not a hidden fallback that reintroduces model drift.

## Interim reality (important)

The bespoke MLX model does not exist yet. This rollout **stands up the MLX runtime now** with an off-the-shelf open vision-language model as the processor, and **keeps the existing regex/heuristic extractor as a validation guardrail over the model's output** — it catches a model confidently misreading an amount, which matters for a compliance module with month-locking and audit logging. The bespoke, fine-tuned model is a later phase that drops into the same slot once the eval harness says it beats the regex baseline on a held-out reconciled month. **Google Vision is removed from the path in this rollout.**

## Resolved open questions

1. **Mac consumer trigger policy:** automatic on network-up (launchd) **and** a manual "Process queue" action. On-demand drain is what makes the system usable the moment a receipt is captured.
2. **Notify the field user when captures finish processing:** out of scope for v1. The review queue surfacing "pending processing → ready for review" is sufficient; revisit if the field user and the desk user diverge.
3. **Eval threshold before a model is trusted over regex:** a model may only outrank the regex baseline on a per-field basis after beating it on the held-out reconciled-month eval (harness already built: `docs/dashboards/slm-eval-dashboard.html`, training export script). Until then, regex is the guardrail and the model is advisory.

## What approving this actually changes for you

You can start capturing May and June receipts immediately. Capture is instant; classification lands a few seconds later when you drain the queue (or automatically when the Mac is online). When you go to close a month, the system will refuse if anything for that window is still sitting unprocessed — that refusal is a feature, not a bug.

## Scope of this change set

Code is implemented and committed on branch `feat/receipts-extraction-queue-mlx` (capture/enqueue, MLX apply + guardrail, pending-processing state, finalize gate, tests). The Cloudflare Queue creation, MLX model install, and deploy are **Mac-side steps** in `docs/runbooks/receipts-extraction-rollout.md` — they require the live bindings this environment does not hold.
