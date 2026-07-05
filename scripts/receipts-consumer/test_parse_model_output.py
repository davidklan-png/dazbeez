"""Unit tests for _parse_model_output (audit finding B5).

Run from scripts/receipts-consumer/:
    CF_ACCOUNT_ID=d CF_QUEUE_ID=d CF_API_TOKEN=d \\
    RECEIPTS_EXTRACT_URL=http://d RECEIPTS_PROCESSOR_KEY=d MLX_MODEL=d \\
    .venv/bin/python3 -m unittest test_parse_model_output -v

consumer.py reads required env vars at module load; the dummies above
satisfy os.environ[...] without exercising any network or model code
(imports inside functions are lazy).

Verifies the structuredParseFailed flag is correctly returned in three
cases: clean JSON, malformed JSON, and no JSON-looking block at all.
Covers the path the audit identified as silently dropping parsed fields.
"""

import json
import os
import sys
import unittest

# Make consumer.py importable without importing mlx_vlm/requests (lazy
# imports inside functions mean module load is safe).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from consumer import _parse_model_output  # noqa: E402


class ParseModelOutputTests(unittest.TestCase):

    def test_clean_json_returns_fields_and_no_flag(self):
        """Happy path: model emitted well-formed JSON with rawText + fields."""
        output = (
            "Some preamble text from the model.\n"
            + json.dumps(
                {
                    "rawText": "株式会社テスト\n合計 ¥1,500",
                    "merchant": "株式会社テスト",
                    "transactionDate": "2026-07-05",
                    "amountMinor": 1500,
                    "currency": "JPY",
                }
            )
        )
        raw_text, fields, parse_failed = _parse_model_output(output)

        self.assertFalse(parse_failed, "clean JSON must not set the flag")
        self.assertEqual(raw_text, "株式会社テスト\n合計 ¥1,500")
        self.assertEqual(fields["merchant"], "株式会社テスト")
        self.assertEqual(fields["amountMinor"], 1500)

    def test_malformed_json_sets_flag_and_returns_no_fields(self):
        """Audit B5: malformed JSON must surface as parse_failed=True so the
        review UI can badge it instead of silently rendering empty fields."""
        output = (
            "Some preamble.\n"
            '{"merchant": "incomplete object missing closing brace,'
            " amountMinor: 1500"  # malformed — no closing }
        )
        raw_text, fields, parse_failed = _parse_model_output(output)

        self.assertTrue(parse_failed, "malformed JSON must set the flag")
        self.assertEqual(fields, {}, "no fields should be returned on parse failure")
        # raw_text falls back to the full output
        self.assertEqual(raw_text, output)

    def test_no_json_block_sets_flag(self):
        """Audit B5: model emitted plain text with no JSON-looking block."""
        output = "Just plain OCR text from the model, no JSON structure at all."
        raw_text, fields, parse_failed = _parse_model_output(output)

        self.assertTrue(parse_failed, "no-JSON-block output must set the flag")
        self.assertEqual(fields, {})
        self.assertEqual(raw_text, output)

    def test_empty_output_sets_flag(self):
        """Edge case: completely empty model output."""
        raw_text, fields, parse_failed = _parse_model_output("")

        self.assertTrue(parse_failed)
        self.assertEqual(fields, {})
        self.assertEqual(raw_text, "")

    def test_json_without_rawtext_still_parses(self):
        """JSON without rawText falls back to text-before-JSON per existing
        behavior — and does NOT set the flag (parse succeeded)."""
        output = 'Some preamble text.\n{"merchant": "ストア"}'
        raw_text, fields, parse_failed = _parse_model_output(output)

        self.assertFalse(parse_failed, "valid JSON must not set the flag")
        # rawText falls back to text before the JSON block
        self.assertEqual(raw_text, "Some preamble text.")
        self.assertEqual(fields.get("merchant"), "ストア")


if __name__ == "__main__":
    unittest.main()
