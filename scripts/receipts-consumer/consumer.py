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

import io
import json
import os
import subprocess
import sys
import tempfile
import time
from typing import Any

import requests

# Runtime tuning comes from the shared queue-policy module (single source of
# truth for the Mac per-pull overrides of the HTTP-consumer defaults). Aliased
# to the historical names so the rest of this file is unchanged.
from queue_policy import (  # same-dir import; consumer.py runs as a script
    MAC_PER_PULL_BATCH_SIZE as BATCH_SIZE,
    MAC_PER_PULL_VISIBILITY_TIMEOUT_MS as VISIBILITY_TIMEOUT_MS,
    MAC_POLL_INTERVAL_S as POLL_INTERVAL_S,
)

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
# the model runtime per batch so jobs are not redelivered mid-process. Values
# are imported above from queue_policy.py (the Mac per-pull overrides of the
# HTTP-consumer defaults).

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

    PDFs are rasterized to PNG (page 0, ~200 DPI) before returning so the MLX
    VLM (which expects a raster input) can read them. Multi-page PDFs warn to
    stderr — receipts should be single-page; we want to know if they aren't.
    Any fitz exception propagates to the caller's existing retry handling.
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

    # PDF → PNG (page 0 only). Lazy import so --help works without pymupdf.
    if suffix.lower() == ".pdf":
        return _rasterize_pdf(receipt_id, path)

    return path


def _rasterize_pdf(receipt_id: str, pdf_path: str) -> str:
    """Render page 0 of a PDF to a ~200 DPI PNG. Returns the PNG path.

    The .pdf temp file is unlinked before returning so the caller's normal
    os.unlink cleanup runs on the PNG instead. Any fitz exception propagates.
    """
    import fitz  # pymupdf — pure-Python wheel, no system deps

    doc = fitz.open(pdf_path)
    try:
        page_count = doc.page_count
        if page_count > 1:
            print(
                f"[warn] {receipt_id}: PDF has {page_count} pages; "
                "only rendering page 0 (receipts should be single-page).",
                file=sys.stderr,
            )
        page = doc.load_page(0)
        # 200 DPI: 72 DPI is PDF's native scale, so 200/72 ≈ 2.78×.
        # Captures fine JA receipt text including small 領収書 numbers.
        matrix = fitz.Matrix(200 / 72, 200 / 72)
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        fd, png_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        pixmap.save(png_path)
    finally:
        doc.close()

    os.unlink(pdf_path)
    return png_path


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

    raw_text, fields, parse_failed = _parse_model_output(output)
    return {"rawText": raw_text, "fields": fields, "structuredParseFailed": parse_failed}


_MODEL_CACHE: dict[str, Any] = {}


def _load_model():
    if "m" not in _MODEL_CACHE:
        from mlx_vlm import load
        _MODEL_CACHE["m"], _MODEL_CACHE["p"] = load(MLX_MODEL)
    return _MODEL_CACHE["m"], _MODEL_CACHE["p"]


def _parse_model_output(output: str) -> tuple[str, dict[str, Any], bool]:
    """Pull the trailing JSON object out of the model output; fall back gracefully.

    Returns (raw_text, fields, structured_parse_failed). The flag is True
    when the model emitted no parseable JSON object — caller passes it
    through to /extract so the review UI can badge "structured parse
    failed" instead of silently rendering empty fields (audit finding B5).
    """
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
            return raw_text, fields, False
        except json.JSONDecodeError:
            # Fall through — flag the parse failure so the operator can
            # distinguish "model emitted nothing" from "model emitted
            # malformed JSON".
            return raw_text, fields, True
    # No JSON-looking block at all in the output.
    return raw_text, fields, True


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


def post_extraction_failed(receipt_id: str, reason: str) -> None:
    """Tell the Worker this receipt's extraction failed permanently.

    The Worker moves extraction_state to 'failed' (only from pending), persists
    the reason into extraction_json, and the review UI surfaces a red
    'extraction failed' pill. Caller then ACKs the queue message — retrying
    the same bytes would produce the same failure, so the message must not
    redeliver forever or land in the DLQ.

    Failures of THIS call (network, 5xx) are swallowed because the caller
    has already classified the original error as permanent and will ACK
    regardless — losing the reason annotation is preferable to retrying
    a poison pill.
    """
    headers = {
        "x-receipts-processor-key": PROCESSOR_KEY,
        "Content-Type": "application/json",
    }
    if CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET
    try:
        requests.post(
            f"{EXTRACT_BASE}/{receipt_id}/extraction-failed",
            headers=headers,
            json={
                "reason": reason[:1000],
                "model": f"mlx_local:{MLX_MODEL.split('/')[-1]}",
            },
            timeout=30,
        )
    except requests.RequestException as exc:
        print(
            f"[warn] {receipt_id}: failed to post extraction-failed ({exc}); "
            "acking anyway — reason will not be visible in the UI.",
            file=sys.stderr,
        )


# ─── Proof-copy derivatives (PR 1) ────────────────────────────────────────────
# A compact proof image generated at ingest and stored alongside the original
# (receipt_files role='proof_copy'; R2 key receipts/<id>/proof.<ext>). The
# sealed proofs ZIP prefers it over the original to keep the accountant bundle
# small (<5 MB vs ~19 MB raw). ALL image work happens HERE on the Mac (PIL) —
# the Worker only stores the bytes (CPU budget, no native image codecs).
#
# Proof generation is ADVISORY: a failure must never fail extraction. The
# consumer builds + posts the derivative after a successful /extract, wrapped so
# any error is logged and swallowed (backfill_proof_copies.py recovers misses).

PROOF_MAX_DIM = 1280
PROOF_JPEG_QUALITY = 70


def make_proof_derivative(image_path: str) -> tuple[bytes, str] | None:
    """Build a compact proof derivative from a local image file.

    Raster images: resize the longest side to <=1280px (never upscale), JPEG
    quality 70, EXIF stripped AFTER baking orientation into the pixels. Returns
    (jpeg_bytes, "image/jpeg").

    PDFs: pass through unchanged (already compact; rasterizing legal documents
    loses the selectable text the accountant relies on). Returns (pdf_bytes,
    "application/pdf").

    Returns None only when a raster image can't be opened (the caller treats
    that as a skipped proof, not a failure). Any other error propagates so the
    caller's advisory wrapper can log it.
    """
    suffix = os.path.splitext(image_path)[1].lower()
    if suffix == ".pdf":
        with open(image_path, "rb") as fh:
            return fh.read(), "application/pdf"

    from PIL import Image, ImageOps  # lazy: keeps --help + unit tests cheap

    try:
        img = Image.open(image_path)
    except Exception:  # noqa: BLE001 — caller treats None as "skip proof"
        return None
    try:
        # Bake EXIF orientation into the pixels, then drop all metadata so no
        # location/camera data ships to the accountant.
        transposed = ImageOps.exif_transpose(img)
        if transposed is not None:
            img = transposed
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        # thumbnail() preserves aspect ratio, fits within the box (longest side
        # <=1280), and never upsizes — exactly the proof sizing we want.
        img.thumbnail(
            (PROOF_MAX_DIM, PROOF_MAX_DIM),
            Image.Resampling.LANCZOS,
        )
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=PROOF_JPEG_QUALITY)
        return buf.getvalue(), "image/jpeg"
    finally:
        img.close()


def fetch_original_bytes(receipt_id: str) -> bytes | None:
    """Fetch the receipt's ORIGINAL file bytes via the Worker /file endpoint.

    Same processor-key proxy as fetch_image, but WITHOUT PDF rasterization.
    Used for proof generation where PDFs must pass through uncompressed:
    fetch_image rasterizes PDFs to PNG for MLX and discards the original, so the
    PDF proof path re-fetches the raw bytes here. Returns None on failure
    (caller skips the proof for this receipt).
    """
    headers = {"x-receipts-processor-key": PROCESSOR_KEY}
    if CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET
    try:
        resp = requests.get(
            f"{EXTRACT_BASE}/{receipt_id}/file",
            headers=headers,
            timeout=60,
        )
        resp.raise_for_status()
        return resp.content
    except requests.RequestException as exc:
        print(
            f"[warn] {receipt_id}: proof original fetch failed ({exc})",
            file=sys.stderr,
        )
        return None


def post_proof(receipt_id: str, derivative: bytes, content_type: str) -> None:
    """POST a proof derivative to the Worker's /proof endpoint.

    Same processor-key + Access-token header pattern as apply_to_worker, but the
    body is raw bytes (image/jpeg or application/pdf), not JSON. Raises on
    non-2xx so the caller can log; proof generation is advisory, so callers
    wrap this in try/except and never let it fail extraction.
    """
    headers = {
        "x-receipts-processor-key": PROCESSOR_KEY,
        "Content-Type": content_type,
    }
    if CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET
    resp = requests.post(
        f"{EXTRACT_BASE}/{receipt_id}/proof",
        headers=headers,
        data=derivative,
        timeout=60,
    )
    resp.raise_for_status()


def generate_proof(
    receipt_id: str, r2_key: str | None, mlx_image_path: str
) -> tuple[bytes, str] | None:
    """Build the proof derivative for a just-extracted receipt.

    For raster images, reuse the file already fetched for MLX (it IS the
    original). For PDFs, fetch_image rasterized to PNG and discarded the
    original — re-fetch the raw PDF here so it passes through uncompressed.
    Returns (bytes, content_type) or None (skip).
    """
    if r2_key and r2_key.lower().endswith(".pdf"):
        raw = fetch_original_bytes(receipt_id)
        if raw is None:
            return None
        return raw, "application/pdf"
    return make_proof_derivative(mlx_image_path)


class PermanentExtractionFailure(Exception):
    """Raised by the consumer for deterministic-permanent local failures we
    detect ourselves (zero-byte download, manifest size mismatch). Distinct
    from third-party exceptions (pymupdf.FileDataError, PIL.Unidentified
    ImageError) which are recognized by name in `is_permanent_extraction_error`.

    Carries a clean `reason` for the extraction-failed endpoint.
    """

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _build_permanent_exception_types() -> tuple[type[Exception], ...]:
    """Lazily resolve the tuple of permanent-failure exception classes.

    Lazy so the module imports without pymupdf/PIL installed (e.g. when
    running --help or unit tests that don't exercise the model path).

    Membership:
      - pymupdf.FileDataError (covers EmptyFileError too — subclass):
        corrupt/truncated/empty PDF, encryption, render failure. Retrying
        the same bytes will throw the same error.
      - PIL.UnidentifiedImageError: corrupt or unsupported raster image.
        Same bytes → same failure.
    """
    types: list[type[Exception]] = []
    try:
        import fitz  # noqa: WPS433 — lazy by design
        if hasattr(fitz, "FileDataError"):
            types.append(fitz.FileDataError)
    except ImportError:
        pass
    try:
        from PIL import UnidentifiedImageError  # noqa: WPS433
        types.append(UnidentifiedImageError)
    except ImportError:
        pass
    return tuple(types)


# Module-level cache so we resolve the tuple at most once per process.
_PERMANENT_TYPES_CACHE: tuple[type[Exception], ...] | None = None


def is_permanent_extraction_error(exc: Exception) -> bool:
    """True for deterministic-permanent local failures (corrupt image, bad PDF,
    zero-byte download).

    Used by per-message and backfill paths to decide: post extraction-failed
    + ACK (permanent) vs. leave unacked for retry (transient).

    Network errors, HTTP 5xx, and model-load/generate errors are deliberately
    NOT permanent — those are environmental and may resolve on retry.
    """
    if isinstance(exc, PermanentExtractionFailure):
        return True
    global _PERMANENT_TYPES_CACHE
    if _PERMANENT_TYPES_CACHE is None:
        _PERMANENT_TYPES_CACHE = _build_permanent_exception_types()
    permanent = _PERMANENT_TYPES_CACHE
    if permanent and isinstance(exc, permanent):
        return True
    # Safety net: pymupdf errors sometimes nest under fitz.errors in newer
    # versions; match by class name so we don't miss them.
    name = exc.__class__.__name__
    return name in ("FileDataError", "EmptyFileError", "UnidentifiedImageError")


def _format_failure_reason(exc: Exception) -> str:
    """Build the reason string for post_extraction_failed."""
    if isinstance(exc, PermanentExtractionFailure):
        return exc.reason[:1000]
    return f"{exc.__class__.__name__}: {exc}"[:1000]


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


def _d1_query(sql: str, *, local: bool = False) -> list[dict[str, Any]]:
    """Run a read-only SQL query against D1 and return rows as dicts.

    local=True targets local D1 (cf:dev) — used by backfill_proof_copies.py
    --local for the seeded dry-run. Default --remote hits the live DB
    (operator-only; never in CI/tests).
    """
    raw = subprocess.check_output(
        ["npx", "wrangler", "d1", "execute", RECEIPTS_DB_NAME,
         "--local" if local else "--remote",
         "--env-file=/dev/null", "--json", "--command", sql],
        text=True,
        env=_wrangler_env(),
    )
    parsed = json.loads(raw)
    return (parsed[0] if isinstance(parsed, list) else parsed).get("results", [])


def _d1_execute(sql: str, *, local: bool = False) -> None:
    """Run a write SQL statement against D1 (remote by default; local for cf:dev)."""
    subprocess.check_output(
        ["npx", "wrangler", "d1", "execute", RECEIPTS_DB_NAME,
         "--local" if local else "--remote",
         "--env-file=/dev/null", "--json", "--command", sql],
        text=True,
        env=_wrangler_env(),
    )


def _sql_escape(v: str | None) -> str:
    """Single-quote-escape a value for SQL. NULL on None."""
    return "NULL" if v is None else "'" + v.replace("'", "''") + "'"


def pull_pending_rows(only_id: str | None = None) -> list[dict[str, Any]]:
    """Pending-extraction rows from D1 (extraction_state captured/queued/processing).

    Excludes 'failed' and soft-deleted rows. Matches listPendingProcessingReceipts
    in lib/receipts/db.ts.

    Why 'failed' is excluded: 'failed' is terminal-until-operator-action. A
    receipt reaches 'failed' either via the no-OCR-text path in /extract (422)
    or via the consumer's permanent-failure classifier (POST extraction-failed).
    Both paths mean "retrying the same bytes will produce the same outcome" —
    so backfill must NOT pick them back up. They are operator-visible in the
    review queue (red 'extraction failed' pill) and require manual intervention
    (replace the file, or enter fields by hand and advance status). To re-attempt
    extraction on a failed row, the operator must first reset extraction_state
    to 'captured' (or re-upload); backfill deliberately won't do that for them.
    """
    where_id = f" AND id = {_sql_escape(only_id)}" if only_id else ""
    return _d1_query(
        "SELECT id, status, extraction_state, extraction_attempts, "
        "original_r2_key, extraction_json, captured_at, merchant "
        "FROM receipt_records "
        "WHERE extraction_state IN ('captured','queued','processing') "
        "AND deleted_at IS NULL "
        # ADR 0011 Phase B: needs_render receipts are awaiting a Mac render
        # before they're extractable — exclude them so backfill/MLX never tries
        # to OCR a raw HTML/text body. Mirrors the needs_render=0 filter in
        # buildPendingProcessingQuery (lib/receipts/extraction-queue-db.ts).
        "AND (needs_render = 0 OR needs_render IS NULL)"
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
                if os.path.getsize(image_path) == 0:
                    raise PermanentExtractionFailure("downloaded file is zero bytes")
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
            if is_permanent_extraction_error(exc):
                # Same logic as the queue path: permanent local failure →
                # mark the receipt failed in the UI, count as extract_fail
                # (no queue to ack here — backfill reads D1 directly).
                reason = _format_failure_reason(exc)
                post_extraction_failed(rid, reason)
                stats["extract_fail"] += 1
                print(
                    f"  [fail-perm]   {label}: {reason} — marked extraction-failed",
                    file=sys.stderr,
                )
            else:
                print(f"  [fail]        {label}: {exc}", file=sys.stderr)
                stats["extract_fail"] += 1

    print(
        f"\nDone. stale-state cleanup: {stats['stale_state']}, "
        f"extract ok: {stats['extract_ok']}, extract fail: {stats['extract_fail']}."
    )
    if dry_run:
        print("Dry-run only. Re-run with --write to apply.")


# ─── Email body auto-promote + render (ADR 0011 Phase B, option b) ───────────
# The standalone email-intake Worker can't call createReceiptRecord (it's
# isolated from cloudflare-runtime — see workers/receipts-email-intake/src/
# cloudflare-env.d.ts), so the Mac consumer drives BOTH halves of the body
# pipeline for allowlisted senders:
#   1. auto-promote: a pending_triage body-only intake from a trusted sender
#      (SPF+DKIM) → POST /inbox/{id}/promote. The Worker route runs the same
#      createReceiptRecord every capture path uses (body-only branch), creating
#      the receipt at source_type 'email_body' with needs_render=1 (NOT enqueued).
#   2. render: a needs_render=1 receipt → fetch its raw body via /file, render
#      to PDF (render_email_body.py: WeasyPrint, NO network, NO JS), POST
#      /{id}/render, which deposits the derivative + clears needs_render +
#      enqueues for normal MLX extraction.
# Both are dry-run by default (--write applies), mirroring --backfill. They are
# meant to run on a periodic timer (separate from this process's MLX loop) —
# wrangler-per-call discovery is too heavy for the per-poll main loop. No MLX
# model is loaded for either mode.

def fetch_trusted_senders() -> list[str]:
    """Read the auto-promote allowlist from D1. The Settings page
    (trusted_intake_senders table) is authoritative — the TRUSTED_INTAKE_SENDERS
    env var was removed. Uses the same _d1_query() path as
    pull_pending_rows/pull_auto_promote_candidates (operator wrangler OAuth, a
    separate auth path from the processor-key HTTP calls). Emails are stored
    lowercase-normalized, so no case-folding here. Called once per launchd
    invocation at the top of process_auto_promote (each run is short-lived; no
    in-memory TTL needed)."""
    rows = _d1_query("SELECT email FROM trusted_intake_senders;")
    return [str(r["email"]) for r in rows if r.get("email")]


def is_auto_promote_eligible(
    from_address: str,
    spf_pass: int | bool | None,
    dkim_pass: int | bool | None,
    has_attachment: bool,
    trusted_senders: list[str],
) -> bool:
    """Mirror of lib/receipts/email-parse.ts isAutoPromoteEligible. Attachments
    use the manual triage path regardless of sender; body-only + a trusted
    sender + SPF and DKIM pass → eligible for auto-promotion. Pure: the caller
    passes the allowlist fetched from D1 (fetch_trusted_senders)."""
    if has_attachment:
        return False
    if not (spf_pass and dkim_pass):
        return False
    return (from_address or "").strip().lower() in trusted_senders


def post_promote(intake_id: str) -> None:
    """POST /api/receipts/inbox/{id}/promote (processor key). Creates the
    receipt via the canonical createReceiptRecord path (body-only branch)."""
    headers = {
        "x-receipts-processor-key": PROCESSOR_KEY,
        "Content-Type": "application/json",
    }
    if CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET
    resp = requests.post(
        f"{EXTRACT_BASE}/inbox/{intake_id}/promote",
        headers=headers,
        timeout=60,
    )
    resp.raise_for_status()


def post_render(receipt_id: str, derivative: bytes, content_type: str) -> None:
    """POST /api/receipts/{id}/render (processor key, raw bytes). Mirrors
    post_proof. Deposits the rendered derivative + clears needs_render +
    enqueues the receipt for MLX extraction."""
    headers = {
        "x-receipts-processor-key": PROCESSOR_KEY,
        "Content-Type": content_type,
    }
    if CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET
    resp = requests.post(
        f"{EXTRACT_BASE}/{receipt_id}/render",
        headers=headers,
        data=derivative,
        timeout=60,
    )
    resp.raise_for_status()


def pull_auto_promote_candidates(
    trusted_senders: list[str], only_id: str | None = None
) -> list[dict[str, Any]]:
    """pending_triage body-only intakes (no attachment) with a captured body,
    that pass the auto-promote gate. Fetches the pending_triage body-only rows
    and filters by the allowlist in Python (the list is small). The caller
    supplies the allowlist (fetched fresh from D1 via fetch_trusted_senders)."""
    where_id = f" AND id = {_sql_escape(only_id)}" if only_id else ""
    rows = _d1_query(
        "SELECT id, from_address, spf_pass, dkim_pass, "
        "attachment_r2_key, body_text, body_html "
        "FROM email_receipt_intake "
        "WHERE status = 'pending_triage'"
        + where_id + ";"
    )
    return [
        r
        for r in rows
        if not r.get("attachment_r2_key")
        and (r.get("body_text") or r.get("body_html"))
        and is_auto_promote_eligible(
            r.get("from_address", ""),
            r.get("spf_pass"),
            r.get("dkim_pass"),
            bool(r.get("attachment_r2_key")),
            trusted_senders,
        )
    ]


def pull_render_pending(only_id: str | None = None) -> list[dict[str, Any]]:
    """receipt_records awaiting a Mac render (needs_render=1)."""
    where_id = f" AND id = {_sql_escape(only_id)}" if only_id else ""
    return _d1_query(
        "SELECT id, original_content_type "
        "FROM receipt_records "
        "WHERE needs_render = 1 AND deleted_at IS NULL"
        + where_id + ";"
    )


def process_auto_promote(dry_run: bool, only_id: str | None = None) -> None:
    """Promote allowlisted body-only intakes into receipts (POST /promote).
    The allowlist is read fresh from D1 (the Settings page is authoritative) on
    every invocation — no env var, no caching across runs."""
    trusted_senders = fetch_trusted_senders()
    if not trusted_senders:
        print(
            "No trusted senders configured (Settings page is empty) — "
            "nothing to auto-promote."
        )
        return
    rows = pull_auto_promote_candidates(trusted_senders, only_id)
    if not rows:
        print(
            f"No auto-promote candidates "
            f"({len(trusted_senders)} trusted sender(s) configured)."
        )
        return
    print(f"{len(rows)} auto-promote candidate(s):")
    for r in rows:
        iid = r["id"]
        label = f"{iid} from={r.get('from_address')}"
        if dry_run:
            print(f"  [dry-run] would promote {label}")
            continue
        try:
            post_promote(iid)
            print(f"  [ok] promoted {label}")
        except Exception as exc:  # noqa: BLE001
            print(f"  [fail] {label}: {exc}", file=sys.stderr)


def process_renders(dry_run: bool, only_id: str | None = None) -> None:
    """Render needs_render receipts: fetch raw body via /file → PDF (no network,
    no JS) → POST /render, which enqueues for normal MLX extraction."""
    from render_email_body import render_body_to_pdf  # lazy: WeasyPrint is heavy

    rows = pull_render_pending(only_id)
    if not rows:
        print("No receipts awaiting render.")
        return
    print(f"{len(rows)} receipt(s) awaiting render:")
    for r in rows:
        rid = r["id"]
        content_type = r.get("original_content_type") or "text/plain"
        if dry_run:
            print(f"  [dry-run] would render {rid} ({content_type})")
            continue
        try:
            body = fetch_original_bytes(rid)  # GET /file → raw body bytes
            if not body:
                print(f"  [skip] {rid}: empty body from /file", file=sys.stderr)
                continue
            pdf = render_body_to_pdf(
                body.decode("utf-8", errors="replace"), content_type
            )
            post_render(rid, pdf, "application/pdf")
            print(f"  [ok] rendered {rid}")
        except Exception as exc:  # noqa: BLE001
            print(f"  [fail] {rid}: {exc}", file=sys.stderr)


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
            # Zero-byte downloads are deterministic-permanent: a 200 OK with
            # an empty body means R2 has nothing for this key. MLX would
            # either crash or produce gibberish; either way retrying won't
            # help. Post failure + ack.
            proof: tuple[bytes, str] | None = None  # built while image_path exists
            try:
                if os.path.getsize(image_path) == 0:
                    raise PermanentExtractionFailure("downloaded file is zero bytes")
                result = run_mlx(image_path)
                # Proof derivative (advisory). Built inside the try so the
                # raster image is still on disk; a build failure is swallowed
                # — it must never block extraction.
                try:
                    proof = generate_proof(receipt_id, r2_key, image_path)
                except Exception as exc:  # noqa: BLE001
                    print(
                        f"[warn] {receipt_id}: proof build failed ({exc})",
                        file=sys.stderr,
                    )
            finally:
                try:
                    os.unlink(image_path)
                except OSError:
                    pass
            apply_to_worker(receipt_id, result)
            # Post the proof only after extraction is confirmed. Advisory: a
            # failure is logged and swallowed (backfill_proof_copies.py recovers
            # misses; the receipt is already extracted and acked regardless).
            if proof is not None:
                try:
                    post_proof(receipt_id, *proof)
                except Exception as exc:  # noqa: BLE001
                    print(
                        f"[warn] {receipt_id}: proof post failed ({exc})",
                        file=sys.stderr,
                    )
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
        except Exception as exc:  # noqa: BLE001
            if is_permanent_extraction_error(exc):
                # Deterministic-permanent local failure (corrupt image / PDF,
                # zero-byte file). Mark the receipt failed so the operator
                # sees it in the review UI, then ack so the message doesn't
                # retry into the DLQ. Transient errors (network, model load,
                # generate) fall through to the unacked-retry path.
                reason = _format_failure_reason(exc)
                post_extraction_failed(receipt_id, reason)
                acked.append(lease_id)
                print(
                    f"[fail-perm] {msg.get('id')} ({receipt_id}): {reason} "
                    "— marked extraction-failed + acked",
                    file=sys.stderr,
                )
            else:
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

    # ADR 0011 Phase B (option b): the Mac consumer drives body-receipt auto-
    # promotion + render. Dry-run by default; --write applies; --id <uuid>
    # narrows. Both return before the MLX model load (neither needs MLX). Meant
    # to run on a periodic timer separate from the queue loop.
    if "--auto-promote" in sys.argv or "--render" in sys.argv:
        dry_run = "--write" not in sys.argv
        only_id = None
        if "--id" in sys.argv:
            i = sys.argv.index("--id")
            if i + 1 >= len(sys.argv):
                print("--id requires a UUID argument", file=sys.stderr)
                sys.exit(2)
            only_id = sys.argv[i + 1]
        if "--auto-promote" in sys.argv:
            process_auto_promote(dry_run=dry_run, only_id=only_id)
        if "--render" in sys.argv:
            process_renders(dry_run=dry_run, only_id=only_id)
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
