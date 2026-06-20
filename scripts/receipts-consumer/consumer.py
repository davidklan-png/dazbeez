#!/usr/bin/env python3
"""
Dazbeez receipts — Mac MLX extraction consumer (ADR 0001).

Store-and-forward processing path. This is the ONLY thing that processes the
extraction queue, and it runs only on the Mac M4 with live Cloudflare creds.

Per batch it:
  1. Pulls messages from the Cloudflare Queue (HTTP pull consumer).
  2. For each job: fetches the original image from R2 (via wrangler).
  3. Runs the local MLX vision-language model to OCR + read fields.
  4. POSTs the result to the Worker's extract endpoint, which applies the
     deterministic regex guardrail, merges fields, and advances the receipt to
     needs_review.
  5. Acks the message on success. On failure the message is left unacked and
     returns to the queue after the visibility timeout — nothing is dropped.

Run on demand:   python3 consumer.py --once
Run as a daemon: python3 consumer.py            (polls; used by launchd on network-up)

Config via env (see .env.example):
  CF_ACCOUNT_ID, CF_QUEUE_ID, CF_API_TOKEN   queues_read + queues_write scope
  RECEIPTS_R2_BUCKET                          e.g. dazbeez-receipts
  RECEIPTS_EXTRACT_URL                        https://dazbeez.com/api/receipts
  RECEIPTS_PROCESSOR_KEY                      matches the Worker secret
  MLX_MODEL                                   e.g. mlx-community/Qwen2-VL-7B-Instruct-4bit
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from typing import Any

import requests

CF_ACCOUNT_ID = os.environ["CF_ACCOUNT_ID"]
CF_QUEUE_ID = os.environ["CF_QUEUE_ID"]
CF_API_TOKEN = os.environ["CF_API_TOKEN"]
R2_BUCKET = os.environ.get("RECEIPTS_R2_BUCKET", "dazbeez-receipts")
EXTRACT_BASE = os.environ["RECEIPTS_EXTRACT_URL"].rstrip("/")
PROCESSOR_KEY = os.environ["RECEIPTS_PROCESSOR_KEY"]
# Validated on the M4 Max (128 GB): 32B-4bit ≈ 18 GB on disk, ~21.6 GB RAM
# (17%), ~26 tok/s. Strong JA accuracy incl. T-invoice numbers + tax math.
MLX_MODEL = os.environ.get("MLX_MODEL", "mlx-community/Qwen3-VL-32B-Instruct-4bit")

QUEUES_API = (
    f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
    f"/queues/{CF_QUEUE_ID}/messages"
)
CF_HEADERS = {"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"}

# Batch / lease tuning. The lease (visibility_timeout) must comfortably exceed
# the model runtime per batch so jobs are not redelivered mid-process.
BATCH_SIZE = 10
VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000
POLL_INTERVAL_S = 20

PROMPT = (
    "You are reading a receipt or tax invoice (Japanese or English). "
    "First transcribe ALL visible text exactly, preserving line breaks. "
    "Then output a single JSON object on the final line with keys: "
    "rawText (the full transcription), merchant, transactionDate (YYYY-MM-DD), "
    "amountMinor (integer total in minor units; JPY has no minor unit so use the "
    "whole-yen integer), currency (ISO 4217), taxAmountMinor, taxRate, "
    "invoiceRegistrationNumber (the T + 13 digits number if present). "
    "Use null for anything not present. Do not guess."
)


def pull_batch() -> list[dict[str, Any]]:
    resp = requests.post(
        f"{QUEUES_API}/pull",
        headers=CF_HEADERS,
        json={"batch_size": BATCH_SIZE, "visibility_timeout_ms": VISIBILITY_TIMEOUT_MS},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("result", {}).get("messages", [])


def ack(lease_ids: list[str]) -> None:
    if not lease_ids:
        return
    requests.post(
        f"{QUEUES_API}/ack",
        headers=CF_HEADERS,
        json={"acks": [{"lease_id": lid} for lid in lease_ids]},
        timeout=30,
    ).raise_for_status()


def fetch_image(r2_key: str) -> str:
    """Download the original image from R2 to a temp file; return the path."""
    suffix = os.path.splitext(r2_key)[1] or ".bin"
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    subprocess.run(
        ["npx", "wrangler", "r2", "object", "get", f"{R2_BUCKET}/{r2_key}",
         "--file", path, "--remote"],
        check=True,
        capture_output=True,
    )
    return path


def run_mlx(image_path: str) -> dict[str, Any]:
    """Run the local MLX VLM and return {rawText, fields}."""
    from mlx_vlm import generate  # imported lazily so --help works without MLX
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import load_config

    model, processor = _load_model()
    config = load_config(MLX_MODEL)
    formatted = apply_chat_template(processor, config, PROMPT, num_images=1)
    result = generate(model, processor, formatted, [image_path], max_tokens=1500, verbose=False)
    # mlx-vlm >= 0.5 returns GenerationResult; older returned str. Handle both.
    output = result.text if hasattr(result, "text") else result

    raw_text, fields = _parse_model_output(output)
    return {"rawText": raw_text, "fields": fields}


_MODEL_CACHE: dict[str, Any] = {}


def _load_model():
    if "m" not in _MODEL_CACHE:
        from mlx_vlm import load
        _MODEL_CACHE["m"], _MODEL_CACHE["p"] = load(MLX_MODEL)
    return _MODEL_CACHE["m"], _MODEL_CACHE["p"]


def _parse_model_output(output: str) -> tuple[str, dict[str, Any]]:
    """Pull the trailing JSON object out of the model output; fall back gracefully."""
    fields: dict[str, Any] = {}
    raw_text = output
    start = output.rfind("{")
    end = output.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(output[start : end + 1])
            raw_text = parsed.get("rawText") or output[:start].strip()
            for k in (
                "merchant", "transactionDate", "amountMinor", "currency",
                "taxAmountMinor", "taxRate", "invoiceRegistrationNumber",
            ):
                if k in parsed:
                    fields[k] = parsed[k]
        except json.JSONDecodeError:
            pass
    return raw_text, fields


def apply_to_worker(receipt_id: str, payload: dict[str, Any]) -> None:
    resp = requests.post(
        f"{EXTRACT_BASE}/{receipt_id}/extract",
        headers={"x-receipts-processor-key": PROCESSOR_KEY, "Content-Type": "application/json"},
        json={**payload, "model": f"mlx_local:{MLX_MODEL.split('/')[-1]}"},
        timeout=60,
    )
    resp.raise_for_status()


def process_once() -> int:
    messages = pull_batch()
    if not messages:
        return 0
    acked: list[str] = []
    for msg in messages:
        lease_id = msg["lease_id"]
        try:
            job = msg["body"] if isinstance(msg["body"], dict) else json.loads(msg["body"])
            receipt_id, r2_key = job["receiptId"], job["r2Key"]
            image_path = fetch_image(r2_key)
            try:
                result = run_mlx(image_path)
            finally:
                try:
                    os.unlink(image_path)
                except OSError:
                    pass
            apply_to_worker(receipt_id, result)
            acked.append(lease_id)
            print(f"[ok] {receipt_id}")
        except Exception as exc:  # noqa: BLE001 — leave unacked for redelivery
            print(f"[retry] {msg.get('id')}: {exc}", file=sys.stderr)
    ack(acked)
    return len(acked)


def main() -> None:
    once = "--once" in sys.argv
    while True:
        try:
            n = process_once()
            if once:
                print(f"Processed {n} message(s).")
                return
            if n == 0:
                time.sleep(POLL_INTERVAL_S)
        except requests.HTTPError as exc:
            print(f"[error] {exc}", file=sys.stderr)
            time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    main()
