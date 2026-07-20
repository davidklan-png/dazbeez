"""Tests for consumer.is_auto_promote_eligible (ADR 0011 Phase B).

The allowlist is now a parameter (fetched from D1 by fetch_trusted_senders),
not a module-level env constant — so these cover the param-based signature:
empty list → nothing eligible; case-insensitive match against a
lowercase-stored list; attachments never auto-promote; SPF/DKIM gate.

Run:
  cd scripts/receipts-consumer && \\
  .venv/bin/python3 -m unittest test_auto_promote_eligible -v
"""
from __future__ import annotations

import os
import sys
import unittest

# consumer.py reads these at import time; default them so the test runs without
# the runtime env (mirrors test_permanent_failure.py / test_proof_derivative.py).
os.environ.setdefault("CF_ACCOUNT_ID", "d")
os.environ.setdefault("CF_QUEUE_ID", "d")
os.environ.setdefault("CF_API_TOKEN", "d")
os.environ.setdefault("RECEIPTS_EXTRACT_URL", "http://d")
os.environ.setdefault("RECEIPTS_PROCESSOR_KEY", "d")
os.environ.setdefault("MLX_MODEL", "d")

sys.path.insert(0, os.path.dirname(__file__))
from consumer import is_auto_promote_eligible  # noqa: E402


class IsAutoPromoteEligibleTests(unittest.TestCase):
    def test_empty_senders_nothing_eligible(self):
        # The Settings-page allowlist is authoritative; empty = no auto-promote.
        self.assertFalse(
            is_auto_promote_eligible("david@gmail.com", True, True, False, [])
        )

    def test_trusted_body_only_spf_dkim_is_eligible(self):
        self.assertTrue(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, ["david@gmail.com", "other@x.com"]
            )
        )

    def test_attachment_never_auto_promoted(self):
        # Attachments use the manual triage path regardless of sender.
        self.assertFalse(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, True, ["david@gmail.com"]
            )
        )

    def test_spf_or_dkim_fail_not_eligible(self):
        senders = ["david@gmail.com"]
        self.assertFalse(
            is_auto_promote_eligible("david@gmail.com", False, True, False, senders)
        )
        self.assertFalse(
            is_auto_promote_eligible("david@gmail.com", True, False, False, senders)
        )

    def test_non_trusted_sender_not_eligible(self):
        self.assertFalse(
            is_auto_promote_eligible(
                "stranger@evil.com", True, True, False, ["david@gmail.com"]
            )
        )

    def test_case_insensitive_vs_lowercase_stored_list(self):
        # from_address arrives mixed-case; the stored list is lowercase-normalized
        # → the function lowercases from_address before the membership check.
        self.assertTrue(
            is_auto_promote_eligible(
                "DAVID@Gmail.com", True, True, False, ["david@gmail.com"]
            )
        )


if __name__ == "__main__":
    unittest.main()
