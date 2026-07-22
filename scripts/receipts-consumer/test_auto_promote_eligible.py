"""Tests for consumer.is_auto_promote_eligible (ADR 0011 Phase B + follow-up).

Covers: empty allowlist, trusted+SPF+DKIM, attachment gate, SPF/DKIM gate,
case-insensitive, blocked sender, prospective trust (older/equal/newer/malformed).

Run:
  cd scripts/receipts-consumer && \\
  .venv/bin/python3 -m unittest test_auto_promote_eligible -v
"""
from __future__ import annotations

import os
import sys
import unittest

os.environ.setdefault("CF_ACCOUNT_ID", "d")
os.environ.setdefault("CF_QUEUE_ID", "d")
os.environ.setdefault("CF_API_TOKEN", "d")
os.environ.setdefault("RECEIPTS_EXTRACT_URL", "http://d")
os.environ.setdefault("RECEIPTS_PROCESSOR_KEY", "d")
os.environ.setdefault("MLX_MODEL", "d")

sys.path.insert(0, os.path.dirname(__file__))
from consumer import is_auto_promote_eligible  # noqa: E402

TRUSTED = {"david@gmail.com": "2000-01-01T00:00:00Z", "other@x.com": "2000-01-01T00:00:00Z"}


class IsAutoPromoteEligibleTests(unittest.TestCase):
    def test_empty_senders_nothing_eligible(self):
        self.assertFalse(
            is_auto_promote_eligible("david@gmail.com", True, True, False, {}, set())
        )

    def test_trusted_body_only_spf_dkim_is_eligible(self):
        self.assertTrue(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, TRUSTED, set(),
                received_at="2026-08-01T00:00:00Z",
            )
        )

    def test_attachment_never_auto_promoted(self):
        self.assertFalse(
            is_auto_promote_eligible("david@gmail.com", True, True, True, TRUSTED, set())
        )

    def test_spf_or_dkim_fail_not_eligible(self):
        self.assertFalse(
            is_auto_promote_eligible("david@gmail.com", False, True, False, TRUSTED, set())
        )
        self.assertFalse(
            is_auto_promote_eligible("david@gmail.com", True, False, False, TRUSTED, set())
        )

    def test_non_trusted_sender_not_eligible(self):
        self.assertFalse(
            is_auto_promote_eligible("stranger@evil.com", True, True, False, TRUSTED, set())
        )

    def test_case_insensitive_vs_lowercase_stored(self):
        self.assertTrue(
            is_auto_promote_eligible(
                "DAVID@Gmail.com", True, True, False, TRUSTED, set(),
                received_at="2026-08-01T00:00:00Z",
            )
        )

    # ── ADR 0011 follow-up: blocked + prospective ──

    def test_blocked_sender_not_eligible_even_if_trusted(self):
        blocked = {"david@gmail.com"}
        self.assertFalse(
            is_auto_promote_eligible("david@gmail.com", True, True, False, TRUSTED, blocked)
        )

    def test_prospective_older_intake_not_eligible(self):
        trusted_new = {"david@gmail.com": "2026-07-01T00:00:00Z"}
        self.assertFalse(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, trusted_new, set(),
                received_at="2026-06-01T00:00:00Z",
            )
        )

    def test_prospective_equal_timestamp_eligible(self):
        trusted = {"david@gmail.com": "2026-07-01T00:00:00Z"}
        self.assertTrue(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, trusted, set(),
                received_at="2026-07-01T00:00:00Z",
            )
        )

    def test_prospective_newer_intake_eligible(self):
        trusted = {"david@gmail.com": "2026-07-01T00:00:00Z"}
        self.assertTrue(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, trusted, set(),
                received_at="2026-08-01T00:00:00Z",
            )
        )

    def test_prospective_malformed_received_at_ineligible(self):
        trusted = {"david@gmail.com": "2026-07-01T00:00:00Z"}
        self.assertFalse(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, trusted, set(),
                received_at="not-a-date",
            )
        )

    def test_prospective_malformed_trusted_created_at_ineligible(self):
        trusted = {"david@gmail.com": "garbage"}
        self.assertFalse(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, trusted, set(),
                received_at="2026-08-01T00:00:00Z",
            )
        )

    def test_missing_received_at_ineligible(self):
        """Missing received_at is ineligible (mandatory for prospective trust)."""
        self.assertFalse(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, TRUSTED, set(),
                received_at=None,
            )
        )

    def test_missing_trusted_created_at_ineligible(self):
        """Missing trusted created_at is ineligible (sender has no trust timestamp)."""
        trusted_no_date = {"david@gmail.com": None}
        self.assertFalse(
            is_auto_promote_eligible(
                "david@gmail.com", True, True, False, trusted_no_date, set(),
                received_at="2026-08-01T00:00:00Z",
            )
        )


if __name__ == "__main__":
    unittest.main()
