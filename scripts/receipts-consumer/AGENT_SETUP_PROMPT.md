# CLI-agent prompt — install & wire up the MLX OCR consumer

Paste the block below to a CLI coding agent (e.g. Claude Code) running **on the Mac M4**, from the repo root. It sets up the local MLX vision model that reads Japanese/English receipts for the store-and-forward extraction path (ADR 0001).

---

You are setting up the local MLX OCR consumer for the Dazbeez receipts module on this Mac (Apple Silicon, 128 GB). Context: ADR 0001 (`docs/adr/0001-receipt-extraction-runtime.md`) made receipt extraction store-and-forward — the Worker enqueues captures to a Cloudflare Queue and THIS machine is the only processor. The consumer already exists at `scripts/receipts-consumer/` (`consumer.py`, `run.sh`, `requirements.txt`, `.env.example`, launchd plist). Your job is to install it, wire it to a Qwen3-VL model, and prove it reads both Japanese and English receipts. Work only in `scripts/receipts-consumer/` and do not deploy anything.

Model decision (already made — use it): **Qwen3-VL**, via `mlx-vlm`. Rationale: current-gen, 32-language OCR including Japanese, robust to blur/tilt/low-light (real receipt photos), strong long-document/table structure parsing (invoices), and LoRA-fine-tunable via mlx-vlm — so the same family covers both the off-the-shelf model now and the bespoke fine-tuned model later (ADR Phase 2). Keep the deterministic regex guardrail in the Worker; do not try to move extraction off it.

Do the following:

1. **Environment.** In `scripts/receipts-consumer/`, create a Python venv and install deps: `python3 -m venv .venv && source .venv/bin/activate && pip install -U -r requirements.txt`. Confirm `mlx-vlm` is recent enough to support Qwen3-VL (needs ≥ 0.3.4); upgrade if not. Print the installed `mlx-vlm` version.

2. **Pick the model.** Default in `.env.example`/`consumer.py` is `mlx-community/Qwen3-VL-4B-Instruct-4bit` (a known-good build for validating the pipeline). On Hugging Face `mlx-community`, check what larger **Qwen3-VL *Instruct*** MLX builds exist (e.g. 8B / 30B, 4-bit or 8-bit). Recommend the largest one that runs comfortably in 128 GB with headroom; report the exact repo id and its size. Do NOT silently switch the default — tell me the options and let me confirm before changing `MLX_MODEL`.

3. **Verify the runtime API.** `consumer.py` calls `mlx_vlm` (`load`, `generate`, `apply_chat_template`, `load_config`). Confirm these match the installed mlx-vlm version's API for Qwen3-VL; if the signatures differ, fix `consumer.py` minimally so a single-image generate works. Do not change the consumer's queue/ack/HTTP contract.

4. **Smoke-test OCR before any queue wiring.** Run the model directly (`python -m mlx_vlm.generate --model <id> --image <path> --prompt "Transcribe all text, then output JSON with merchant, transactionDate, amountMinor, currency, taxAmountMinor, taxRate, invoiceRegistrationNumber. Use null if absent."`) on TWO sample receipts: one **Japanese** (with 合計/消費税/T-invoice number) and one **English**. Show the raw output for each. Acceptance: merchant, date, and total are correct on both; the Japanese invoice registration number (T + 13 digits) is captured when present. If Japanese is weak, try the next larger Qwen3-VL build and report the difference.

5. **Wire config.** Copy `.env.example` to `.env` and fill `CF_ACCOUNT_ID`, `CF_QUEUE_ID`, `CF_API_TOKEN` (Queues Read+Write — no R2 scope needed; the consumer fetches images through the Worker), `RECEIPTS_EXTRACT_URL`, `RECEIPTS_PROCESSOR_KEY`, `MLX_MODEL`. Never print secret values back in full and never commit `.env` (confirm it is gitignored).

6. **End-to-end dry run.** With at least one receipt sitting in the queue (status `captured`), run `./run.sh --once`. Confirm it pulls the job, fetches the R2 image, runs the model, POSTs to the extract endpoint, and the receipt advances to `needs_review` with fields populated. Show the consumer log.

7. **Optional autostart.** If I confirm, install the launchd agent (`com.dazbeez.receipts-consumer.plist`) per the comments in that file so the queue drains on login/wake.

Report at the end: installed mlx-vlm version, chosen model id + memory footprint + tokens/sec, JA and EN smoke-test results, and any edits you made to `consumer.py`. Do not run `wrangler deploy`, `cf:dev`, or modify Worker code.

---

## Notes for David (not part of the prompt)

- **Why Qwen3-VL over a dedicated OCR engine** (PaddleOCR, manga-ocr, olmOCR-2, MinerU2.5): those can edge out a general VLM on pure transcription, but a VLM transcribes *and* emits the structured fields (merchant/total/tax/invoice no.) in one pass, and — the strategic part — Qwen3-VL is the same family you'll LoRA-fine-tune for the bespoke model, so you never change architectures between "off-the-shelf now" and "our model later." One slot, one eval harness.
- **Size vs. accuracy:** processing is async/batch, so a bigger model is essentially free on latency — accuracy is the only thing that matters. Start 4B to prove the pipe, then scale up; the 128 GB headroom is there to be used.
- **The guardrail stays.** The regex parser already validates the model's amount/date in the Worker. Don't let model accuracy claims tempt anyone into dropping it for a compliance module.
