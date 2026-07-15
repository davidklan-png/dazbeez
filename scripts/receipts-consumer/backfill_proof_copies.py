#!/usr/bin/env python3
"""Backfill proof-copy derivatives for receipts that lack one.

Proof copies are normally generated at ingest by consumer.py (PR 1). This
script recovers receipts captured BEFORE that path shipped, or whose proof post
failed (advisory — extraction succeeded but no proof_copy row landed).

Runs on the Mac against D1 + the Worker /proof endpoint:
  --dry-run (default): print a plan table, write nothing.
  --write:             fetch each original, build the derivative, POST /proof.
  --local:             target LOCAL D1 (cf:dev) — for the seeded dry-run demo.
                       Default is --remote (live; operator-only).
  --force:             regenerate even where a proof_copy already exists.
  --id <uuid>:         narrow to one receipt.

Idempotent + resumable: by default it selects only receipts WITHOUT a
proof_copy, so re-running after a partial --write picks up exactly the rest.

Run (Mac, venv):
  .venv/bin/python3 backfill_proof_copies.py --local --dry-run    # seeded cf:dev
  .venv/bin/python3 backfill_proof_copies.py --remote --dry-run   # live plan (read-only)
  .venv/bin/python3 backfill_proof_copies.py --remote --write     # apply
"""
from __future__ import annotations

import os
import sys
import tempfile

# consumer.py reads these at import time. Default them so --help / --dry-run
# work without the full runtime env; --write (posting) needs real values.
os.environ.setdefault("CF_ACCOUNT_ID", "d")
os.environ.setdefault("CF_QUEUE_ID", "d")
os.environ.setdefault("CF_API_TOKEN", "d")
os.environ.setdefault("RECEIPTS_EXTRACT_URL", "http://d")
os.environ.setdefault("RECEIPTS_PROCESSOR_KEY", "d")
os.environ.setdefault("MLX_MODEL", "d")

import consumer  # type: ignore  # noqa: E402


def list_receipts_needing_proof(
    *, local: bool, force: bool, only_id: str | None
) -> list[dict]:
    """Receipts to (re)generate a proof_copy for.

    Default: non-deleted receipts with an original file and NO proof_copy row.
    --force: all non-deleted receipts with an original file (regenerate existing).
    """
    where_id = f" AND r.id = {consumer._sql_escape(only_id)}" if only_id else ""
    if force:
        clause = ""
    else:
        # NOT EXISTS a proof_copy row — the idempotency guard. Re-running after
        # a partial --write selects exactly the remaining misses.
        clause = (
            "AND NOT EXISTS ("
            " SELECT 1 FROM receipt_files rf"
            " WHERE rf.object_type = 'receipt' AND rf.object_id = r.id"
            " AND rf.role = 'proof_copy')"
        )
    return consumer._d1_query(
        "SELECT r.id, r.merchant, r.original_r2_key, r.captured_at "
        "FROM receipt_records r "
        "WHERE r.deleted_at IS NULL "
        "AND r.original_r2_key IS NOT NULL "
        + clause
        + where_id
        + " ORDER BY r.captured_at;",
        local=local,
    )


def build_proof_from_original(
    receipt_id: str, r2_key: str
) -> tuple[bytes, str] | None:
    """Fetch the original file and build its proof derivative.

    Writes the fetched bytes to a temp file with the right suffix so
    make_proof_derivative can branch (PDF pass-through vs JPEG recompress).
    """
    raw = consumer.fetch_original_bytes(receipt_id)
    if raw is None:
        return None
    suffix = ".pdf" if r2_key.lower().endswith(".pdf") else ".jpg"
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    try:
        with open(path, "wb") as fh:
            fh.write(raw)
        return consumer.make_proof_derivative(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main() -> None:
    args = sys.argv[1:]
    dry_run = "--write" not in args
    local = "--local" in args
    force = "--force" in args
    only_id = None
    if "--id" in args:
        i = args.index("--id")
        if i + 1 >= len(args):
            print("--id requires a UUID argument", file=sys.stderr)
            sys.exit(2)
        only_id = args[i + 1]

    target = "LOCAL D1 (cf:dev)" if local else "REMOTE D1 (live)"
    mode = "[dry-run]" if dry_run else "[WRITE]"
    rows = list_receipts_needing_proof(local=local, force=force, only_id=only_id)

    print(f"Proof-copy backfill — {target} {mode} — force={force}")
    if not rows:
        print("No receipts need a proof_copy. Clean.")
        return
    print(f"{'id':36}  {'merchant':24}  original_r2_key")
    print("-" * 92)
    stats = {"ok": 0, "fail": 0, "skip": 0}
    for r in rows:
        rid = str(r["id"])
        merchant = str(r.get("merchant") or "")[:24]
        r2_key = str(r["original_r2_key"])
        print(f"{rid:36}  {merchant:24}  {r2_key}")
        if dry_run:
            continue
        proof = build_proof_from_original(rid, r2_key)
        if proof is None:
            print(f"  [skip] {rid}: could not build proof", file=sys.stderr)
            stats["skip"] += 1
            continue
        try:
            consumer.post_proof(rid, *proof)
            stats["ok"] += 1
            print(f"  [ok]   {rid}")
        except Exception as exc:  # noqa: BLE001
            print(f"  [fail] {rid}: {exc}", file=sys.stderr)
            stats["fail"] += 1

    print(
        f"\nDone. ok={stats['ok']}, fail={stats['fail']}, skip={stats['skip']} "
        f"(of {len(rows)} candidate)."
    )
    if dry_run:
        print("Dry-run only. Re-run with --write to apply.")


if __name__ == "__main__":
    main()
