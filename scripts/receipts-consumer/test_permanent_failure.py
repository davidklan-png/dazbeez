"""Tests for the permanent-failure classifier in consumer.py.

Run:
  cd scripts/receipts-consumer && \\
  CF_ACCOUNT_ID=d CF_QUEUE_ID=d CF_API_TOKEN=d \\
  RECEIPTS_EXTRACT_URL=http://d RECEIPTS_PROCESSOR_KEY=d MLX_MODEL=d \\
  .venv/bin/python3 -m unittest test_permanent_failure -v
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

# Need to import consumer AFTER setting dummy env vars. The conftest pattern
# isn't worth it for one test file — set env via the runner documented above,
# or via the test_loads_import helper.
import os
os.environ.setdefault("CF_ACCOUNT_ID", "d")
os.environ.setdefault("CF_QUEUE_ID", "d")
os.environ.setdefault("CF_API_TOKEN", "d")
os.environ.setdefault("RECEIPTS_EXTRACT_URL", "http://d")
os.environ.setdefault("RECEIPTS_PROCESSOR_KEY", "d")
os.environ.setdefault("MLX_MODEL", "d")

import consumer  # type: ignore


class TestPermanentFailureClassifier(unittest.TestCase):
    def test_permanent_extraction_failure_is_permanent(self):
        """Self-raised PermanentExtractionFailure → True."""
        exc = consumer.PermanentExtractionFailure("downloaded file is zero bytes")
        self.assertTrue(consumer.is_permanent_extraction_error(exc))
        # Reason accessor preserves the clean message.
        self.assertEqual(
            consumer._format_failure_reason(exc),
            "downloaded file is zero bytes",
        )

    def test_fitz_file_data_error_is_permanent(self):
        """Real pymupdf FileDataError (raised on truncated PDFs) → True."""
        import fitz
        import tempfile
        # Truncated PDF: header + EOF marker, no actual page data. pymupdf
        # raises FileDataError ("Failed to open file ... as type pdf").
        fd, path = tempfile.mkstemp(suffix=".pdf")
        os.write(fd, b"%PDF-1.4\n%%EOF\n")
        os.close(fd)
        try:
            with self.assertRaises(Exception) as ctx:
                fitz.open(path)
            self.assertTrue(
                consumer.is_permanent_extraction_error(ctx.exception),
                f"expected permanent, got {type(ctx.exception).__name__}: {ctx.exception}",
            )
        finally:
            os.unlink(path)

    def test_fitz_empty_file_is_permanent(self):
        """Empty file → fitz.EmptyFileError (subclass of FileDataError) → True."""
        import fitz
        import tempfile
        fd, path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)  # leave the file empty
        try:
            with self.assertRaises(Exception) as ctx:
                fitz.open(path)
            self.assertTrue(consumer.is_permanent_extraction_error(ctx.exception))
        finally:
            os.unlink(path)

    def test_pil_unidentified_image_error_is_permanent(self):
        """PIL.UnidentifiedImageError on a non-image blob → True."""
        from PIL import UnidentifiedImageError
        import io
        from PIL import Image
        # 100 bytes of garbage — not a recognizable image format.
        try:
            Image.open(io.BytesIO(b"not an image at all" * 10))
            self.fail("Image.open should have raised")
        except Exception as exc:
            # PIL raises UnidentifiedImageError for unknown formats. The
            # exact subclass can vary; the classifier should catch the
            # canonical name even if isinstance fails.
            self.assertIsInstance(exc, UnidentifiedImageError)
            self.assertTrue(consumer.is_permanent_extraction_error(exc))

    def test_network_error_is_transient(self):
        """requests.ConnectionError must NOT be permanent — retry should follow."""
        import requests
        exc = requests.ConnectionError("network down")
        self.assertFalse(consumer.is_permanent_extraction_error(exc))

    def test_timeout_is_transient(self):
        """requests.Timeout must NOT be permanent."""
        import requests
        exc = requests.Timeout("read timed out")
        self.assertFalse(consumer.is_permanent_extraction_error(exc))

    def test_generic_runtime_error_is_transient(self):
        """Model generate() / generic RuntimeError must NOT be permanent.

        MLX inference failures are typically RuntimeError or torch errors;
        they're environmental and may resolve on retry. Misclassifying them
        as permanent would silently ack recoverable failures.
        """
        exc = RuntimeError("mlx generate failed: CUDA OOM")
        self.assertFalse(consumer.is_permanent_extraction_error(exc))

    def test_value_error_is_transient(self):
        """ValueError must NOT be permanent (model output shape, dtype, etc.)."""
        exc = ValueError("expected 4D tensor")
        self.assertFalse(consumer.is_permanent_extraction_error(exc))

    def test_format_reason_truncates_to_1000_chars(self):
        """Reason longer than 1000 chars is truncated (endpoint enforces)."""
        long_reason = "x" * 2000
        exc = consumer.PermanentExtractionFailure(long_reason)
        truncated = consumer._format_failure_reason(exc)
        self.assertEqual(len(truncated), 1000)

    def test_post_extraction_failed_swallows_network_error(self):
        """A failed POST to extraction-failed must NOT raise — caller will
        ACK regardless, and the alternative (re-raising) would leak a
        network error into the ack-decision path."""
        with patch("consumer.requests.post", side_effect=__import__("requests").RequestException("network down")):
            # Should not raise.
            consumer.post_extraction_failed("r1", "test reason")


if __name__ == "__main__":
    unittest.main()
