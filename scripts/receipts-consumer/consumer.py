#!/usr/bin/env python3
"""
Dazbeez receipts — Mac MLX extraction consumer (ADR 0001).

Store-and-forward processing path. This is the ONLY thing that processes the
extraction queue, and it runs only on the Mac M4 with live Cloudflare creds.

Per batch it:
  1. Pulls messages from the Cloudflare Queue (HTTP pull consumer).
  2. For each job: fetches the original image via the Worker's /file endpoint
     (the Worker proxies R2 with the same processor key — ADR 0001).
  3. Runs the local MLX vision-language model to OCR + read fields.
  4. POSTs the result to the Worker's extract endpoint, which applies the
     deterministic regex guardrail, merges fields, and advances the receipt to
     needs_review.
  5. Acks the message on success. On failure the message is left unacked and
     returns to the queue after the visibility timeout — nothing is dropped.

Run on demand:   python3 consumer.py --once
Run as a daemon: python3 consumer.py            (polls; used by launchd on network-up)

Recovery:        python3 consumer.py --backfill              # dry-run: list stranded rows
                 python3 consumer.py --backfill --write      # apply: clean up / re-extract
                 python3 consumer.py --backfill --id <uuid>  # surgical, single receipt

Config via env (see .env.example):
  CF_ACCOUNT_ID, CF_QUEUE_ID, CF_API_TOKEN   queues_read + queues_write scope
  RECEIPTS_EXTRACT_URL                        https://dazbeez.com/api/receipts
  RECEIPTS_PROCESSOR_KEY                      matches the Worker secret
  MLX_MODEL                                   e.g. mlx-community/Qwen3-VL-32B-Instruct-4bit
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
EXTRACT_BASE = os.environ["RECEIPTS_EXTRACT_URL"].rstrip("/")
PROCESSOR_KEY = os.environ["RECEIPTS_PROCESSOR_KEY"]
# Optional: if a Cloudflare Access *application* fronts /api/receipts/* at the
# edge, the processor key alone won't get past it — Access blocks the request
# before the Worker runs. Provide an Access service token (and add a service-
# token policy on the Access app) so the consumer can reach the endpoint.
CF_ACCESS_CLIENT_ID = os.environ.get("CF_ACCESS_CLIENT_ID", "")
CF_ACCESS_CLIENT_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
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


def fetch_image(receipt_id: str, r2_key: str) -> str:
    """Download the original image via the Worker's /file endpoint.

    The Worker proxies R2 with the same processor key the consumer uses to POST
    extraction results (ADR 0001) — so the consumer needs no R2 scope on its
    Cloudflare API token, and never shells out to wrangler per image.
    """
    suffix = os.path.splitext(r2_key)[1] or ".bin"
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    headers = {"x-receipts-processor-key": PROCESSOR_KEY}
    if CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET
    resp = requests.get(
        f"{EXTRACT_BASE}/{receipt_id}/file",
        headers=headers,
        stream=True,
        timeout=60,
    )
    resp.raise_for_status()
    with open(path, "wb") as fh:
        for chunk in resp.iter_content(chunk_size=65536):
            if chunk:
                fh.write(chunk)
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
    headers = {
        "x-receipts-processor-key": PROCESSOR_KEY,
        "Content-Type": "application/json",
    }
    # Pass the Access service token through if configured (gets past an edge
    # Cloudflare Access application; harmless if Access isn't fronting the API).
    if CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET
    resp = requests.post(
        f"{EXTRACT_BASE}/{receipt_id}/extract",
        headers=headers,
        json={**payload, "model": f"mlx_local:{MLX_MODEL.split('/')[-1]}"},
        timeout=60,
    )
    resp.raise_for_status()


# ─── Backfill drain (--backfill mode) ────────────────────────────────────────
# Recovery path for receipts stranded in a pending extraction_state — typically
# because the queue consumer acked a 4xx poison pill (409 locked, 422 no OCR)
# but the D1 row's extraction_state never advanced. Reads pending rows straight
# from D1, so no re-enqueue is needed (per ADR 0001 recovery design).
#
# Two row shapes:
#   - stale-state: status is past needs_review (reviewed/reconciled/...) with a
#     stuck extraction_state — the data already exists, just clean up the state.
#   - real-capture: status is captured/needs_review with no prior OCR — run the
#     full MLX path and POST to /extract (same as the queue path).
#
# Dry-run by default (matches scripts/reprocess-extraction.ts); --write applies.

RECEIPTS_DB_NAME = "dazbeez-receipts"
# Statuses that have already been extracted and must NOT be re-extracted —
# /extract's guard returns 409 for these. They only need state cleanup.
LOCKED_STATUSES = {
    "reviewed", "categorized", "reconciled", "exported", "archived",
}


def _wrangler_env() -> dict[str, str]:
    """Environment for wrangler subprocess calls.

    run.sh sources the consumer's .env (so CF_API_TOKEN is in the env), and
    wrangler prefers CF_API_TOKEN over its OAuth token from `wrangler login`.
    The consumer's token is Queues-scoped, so any D1/R2 call dies with code
    7403. Strip CF_* so wrangler falls back to its full-scope OAuth token.
    """
    env = {**os.environ}
    for k in ("CF_API_TOKEN", "CF_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
        env.pop(k, None)
    return env


def _d1_query(sql: str) -> list[dict[str, Any]]:
    """Run a read-only SQL query against remote D1 and return rows as dicts."""
    raw = subprocess.check_output(
        ["npx", "wrangler", "d1", "execute", RECEIPTS_DB_NAME,
         "--remote", "--env-file=/dev/null", "--json", "--command", sql],
        text=True,
        env=_wrangler_env(),
    )
    parsed = json.loads(raw)
    return (parsed[0] if isinstance(parsed, list) else parsed).get("results", [])


def _d1_execute(sql: str) -> None:
    """Run a write SQL statement against remote D1."""
    subprocess.check_output(
        ["npx", "wrangler", "d1", "execute", RECEIPTS_DB_NAME,
         "--remote", "--env-file=/dev/null", "--json", "--command", sql],
        text=True,
        env=_wrangler_env(),
    )


def _sql_escape(v: str | None) -> str:
    """Single-quote-escape a value for SQL. NULL on None."""
    return "NULL" if v is None else "'" + v.replace("'", "''") + "'"


def pull_pending_rows(only_id: str | None = None) -> list[dict[str, Any]]:
    """Pending-extraction rows from D1 (extraction_state captured/queued/processing).

    Excludes 'failed' (the user's check query matches this set) and soft-deleted
    rows. Matches listPendingProcessingReceipts in lib/receipts/db.ts.
    """
    where_id = f" AND id = {_sql_escape(only_id)}" if only_id else ""
    return _d1_query(
        "SELECT id, status, extraction_state, extraction_attempts, "
        "original_r2_key, extraction_json, captured_at, merchant "
        "FROM receipt_records "
        "WHERE extraction_state IN ('captured','queued','processing') "
        "AND deleted_at IS NULL"
        + where_id +
        " ORDER BY captured_at;"
    )


def mark_extraction_processed(receipt_id: str) -> None:
    """Clean up stale extraction_state on a row that was already processed
    (status past needs_review) but never had its state advanced."""
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    _d1_execute(
        "UPDATE receipt_records "
        f"SET extraction_state = 'processed', "
        f"extraction_processed_at = {_sql_escape(now)} "
        f"WHERE id = {_sql_escape(receipt_id)} "
        "AND extraction_state IN ('captured','queued','processing') "
        "AND deleted_at IS NULL;"
    )


def process_backfill(dry_run: bool, only_id: str | None = None) -> None:
    """Drain pending extraction_state rows directly from D1 — no queue needed."""
    rows = pull_pending_rows(only_id)
    if not rows:
        print("No pending extraction rows. Clean.")
        return

    # Decide whether the model is needed: only for real-capture rows that
    # require re-extraction. Stale-state cleanups skip the 18 GB load.
    needs_model = any(
        r["status"] not in LOCKED_STATUSES for r in rows
    ) and not dry_run
    if needs_model:
        try:
            print(f"Loading {MLX_MODEL} …", file=sys.stderr)
            _load_model()
            print("Model ready.", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            print(f"[fatal] model load failed: {exc}", file=sys.stderr)
            sys.exit(1)

    print(
        f"Backfilling {len(rows)} row(s) "
        f"{'[WRITE]' if not dry_run else '[dry-run]'}\n"
    )

    stats = {"stale_state": 0, "extract_ok": 0, "extract_fail": 0}
    for r in rows:
        rid = str(r["id"])
        status = str(r["status"])
        state = str(r["extraction_state"])
        label = f"{rid} status={status} state={state}"

        # Path 1: locked status with stuck extraction_state — clean up only.
        # Re-extracting would 409; the row already has data.
        if status in LOCKED_STATUSES:
            stats["stale_state"] += 1
            print(f"  [stale-state] {label} -> extraction_state='processed'")
            if not dry_run:
                mark_extraction_processed(rid)
            continue

        # Path 2: real capture/needs_review row that needs MLX extraction.
        # Dry-run skips the actual fetch+run so the report is safe to preview.
        if dry_run:
            print(f"  [extract]     {label} (dry-run: would fetch image + run MLX + POST /extract)")
            continue

        r2_key = str(r["original_r2_key"]) if r["original_r2_key"] else None
        if not r2_key:
            print(f"  [skip]        {label} — no original_r2_key, cannot fetch image", file=sys.stderr)
            stats["extract_fail"] += 1
            continue

        try:
            image_path = fetch_image(rid, r2_key)
            try:
                result = run_mlx(image_path)
            finally:
                try:
                    os.unlink(image_path)
                except OSError:
                    pass
            apply_to_worker(rid, result)
            stats["extract_ok"] += 1
            print(f"  [ok]          {label}")
        except requests.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else 0
            body = (exc.response.text[:200] if exc.response is not None else "").replace("\n", " ")
            print(f"  [fail-http{status_code}] {label} body={body!r}", file=sys.stderr)
            stats["extract_fail"] += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  [fail]        {label}: {exc}", file=sys.stderr)
            stats["extract_fail"] += 1

    print(
        f"\nDone. stale-state cleanup: {stats['stale_state']}, "
        f"extract ok: {stats['extract_ok']}, extract fail: {stats['extract_fail']}."
    )
    if dry_run:
        print("Dry-run only. Re-run with --write to apply.")


def process_once() -> int:
    messages = pull_batch()
    if not messages:
        return 0
    acked: list[str] = []
    for msg in messages:
        lease_id = msg["lease_id"]
        receipt_id = "?"
        try:
            job = msg["body"] if isinstance(msg["body"], dict) else json.loads(msg["body"])
            receipt_id, r2_key = job["receiptId"], job["r2Key"]
            image_path = fetch_image(receipt_id, r2_key)
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
        except requests.HTTPError as exc:
            # 4xx from the Worker is permanent: receipt locked (409), not found
            # (404), no OCR text (422), bad processor key (401). Retrying won't
            # change the outcome — ack so the message doesn't redeliver forever.
            status = exc.response.status_code if exc.response is not None else 0
            if 400 <= status < 500:
                body = (exc.response.text[:200] if exc.response is not None else "").replace("\n", " ")
                acked.append(lease_id)
                print(f"[drop] {receipt_id}: HTTP {status} — permanent, acking. body={body!r}", file=sys.stderr)
            else:
                print(f"[retry] {msg.get('id')} ({receipt_id}): {exc}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 — leave unacked for redelivery
            print(f"[retry] {msg.get('id')} ({receipt_id}): {exc}", file=sys.stderr)
    ack(acked)
    return len(acked)


def main() -> None:
    once = "--once" in sys.argv
    backfill = "--backfill" in sys.argv

    # Backfill mode drains pending extraction_state rows directly from D1 — no
    # queue involved. Dry-run by default; --write applies. Optional --id <uuid>
    # narrows to a single row.
    if backfill:
        dry_run = "--write" not in sys.argv
        only_id = None
        if "--id" in sys.argv:
            i = sys.argv.index("--id")
            if i + 1 >= len(sys.argv):
                print("--id requires a UUID argument", file=sys.stderr)
                sys.exit(2)
            only_id = sys.argv[i + 1]
        process_backfill(dry_run=dry_run, only_id=only_id)
        return

    # Pre-warm the model BEFORE pulling any messages. The model load (cold:
    # download + load of an 18 GB model) must not happen inside a message lease,
    # or the visibility timeout could expire mid-batch and the jobs get
    # redelivered. Loading first means the lease only ever covers inference.
    try:
        print(f"Loading {MLX_MODEL} …", file=sys.stderr)
        _load_model()
        print("Model ready.", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[fatal] model load failed: {exc}", file=sys.stderr)
        sys.exit(1)

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
