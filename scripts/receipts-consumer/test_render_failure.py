"""Tests for the render leg's permanent-failure handling (backlog #22).

Covers:
  - the explicit allowlist classifier (PermanentRenderError only)
  - process_renders: empty body → terminal report; None body → transient;
    permanent render error → terminal report; other errors → retryable
  - pull_render_pending excludes extraction_state='failed' rows (the retry
    stop) while legacy stalled rows (captured) stay in the pool

Run:
  cd scripts/receipts-consumer && \\
  CF_ACCOUNT_ID=d CF_QUEUE_ID=d CF_API_TOKEN=d \\
  RECEIPTS_EXTRACT_URL=http://d RECEIPTS_PROCESSOR_KEY=d MLX_MODEL=d \\
  .venv/bin/python3 -m unittest test_render_failure -v
"""
from __future__ import annotations

import os
import unittest
from unittest.mock import patch

os.environ.setdefault("CF_ACCOUNT_ID", "d")
os.environ.setdefault("CF_QUEUE_ID", "d")
os.environ.setdefault("CF_API_TOKEN", "d")
os.environ.setdefault("RECEIPTS_EXTRACT_URL", "http://d")
os.environ.setdefault("RECEIPTS_PROCESSOR_KEY", "d")
os.environ.setdefault("MLX_MODEL", "d")

import consumer  # type: ignore
from render_email_body import PermanentRenderError  # type: ignore


class TestPermanentRenderClassifier(unittest.TestCase):
    def test_permanent_render_error_is_permanent(self):
        exc = PermanentRenderError("WeasyPrint produced an empty PDF")
        self.assertTrue(consumer.is_permanent_render_error(exc))

    def test_network_error_is_transient(self):
        import requests
        self.assertFalse(
            consumer.is_permanent_render_error(requests.ConnectionError("down"))
        )
        self.assertFalse(
            consumer.is_permanent_render_error(requests.Timeout("timed out"))
        )

    def test_generic_runtime_error_is_transient(self):
        """WeasyPrint environmental failures raise generic errors — retryable."""
        self.assertFalse(
            consumer.is_permanent_render_error(RuntimeError("pango missing"))
        )
        self.assertFalse(consumer.is_permanent_render_error(ValueError("bad")))

    def test_http_error_is_transient(self):
        """A 4xx/5xx from /render is environmental (or our own bug) — never
        terminal. Misclassifying our own consumer bug would mark EVERY
        receipt terminal."""
        import requests
        err = requests.HTTPError("500 Server Error")
        self.assertFalse(consumer.is_permanent_render_error(err))

    def test_extraction_failure_class_is_not_a_render_failure(self):
        """The two legs' classifiers must not cross-match."""
        exc = consumer.PermanentExtractionFailure("zero bytes")
        self.assertFalse(consumer.is_permanent_render_error(exc))
        self.assertTrue(consumer.is_permanent_extraction_error(exc))


class TestPullRenderPendingExcludesTerminal(unittest.TestCase):
    def test_pull_sql_excludes_failed_rows(self):
        """The retry stop: terminal rows leave the pending pool. Asserting on
        the SQL text (same style as the Node pipeline-health tests) because
        running it would need a live D1."""
        import inspect
        source = inspect.getsource(consumer.pull_render_pending)
        self.assertIn("extraction_state != 'failed'", source)
        # NULL-safe: a needs_render row with NULL extraction_state stays in
        # the pool (SQL `NULL != 'failed'` would silently drop it).
        self.assertIn("extraction_state IS NULL OR extraction_state != 'failed'", source)
        self.assertIn("needs_render = 1", source)
        self.assertIn("deleted_at IS NULL", source)


class TestProcessRenders(unittest.TestCase):
    def _rows(self, rid="rid-1"):
        return [{"id": rid, "original_content_type": "text/html"}]

    def test_empty_body_is_terminal(self):
        """Zero-byte body from /file → post_render_failed, no post_render."""
        with patch.object(consumer, "pull_render_pending", return_value=self._rows()), \
             patch.object(consumer, "fetch_original_bytes", return_value=b""), \
             patch.object(consumer, "post_render_failed", return_value=True) as fail, \
             patch.object(consumer, "post_render") as ok:
            consumer.process_renders(dry_run=False)
        ok.assert_not_called()
        fail.assert_called_once()
        rid, reason = fail.call_args[0]
        self.assertEqual(rid, "rid-1")
        self.assertIn("empty", reason)

    def test_none_body_is_transient(self):
        """Fetch failure (None) → no terminal report; retried next cycle."""
        with patch.object(consumer, "pull_render_pending", return_value=self._rows()), \
             patch.object(consumer, "fetch_original_bytes", return_value=None), \
             patch.object(consumer, "post_render_failed", return_value=True) as fail, \
             patch.object(consumer, "post_render") as ok:
            consumer.process_renders(dry_run=False)
        ok.assert_not_called()
        fail.assert_not_called()

    def test_permanent_render_error_is_terminal(self):
        """PermanentRenderError from the renderer → post_render_failed."""
        with patch.object(consumer, "pull_render_pending", return_value=self._rows()), \
             patch.object(consumer, "fetch_original_bytes", return_value=b"<html>x</html>"), \
             patch(
                 "render_email_body.render_body_to_pdf",
                 side_effect=PermanentRenderError("WeasyPrint produced an empty PDF"),
             ), \
             patch.object(consumer, "post_render_failed", return_value=True) as fail, \
             patch.object(consumer, "post_render") as ok:
            consumer.process_renders(dry_run=False)
        ok.assert_not_called()
        fail.assert_called_once()
        self.assertIn("empty PDF", fail.call_args[0][1])

    def test_transient_render_error_stays_retryable(self):
        """Generic renderer error → NO terminal report (stderr only)."""
        with patch.object(consumer, "pull_render_pending", return_value=self._rows()), \
             patch.object(consumer, "fetch_original_bytes", return_value=b"<html>x</html>"), \
             patch(
                 "render_email_body.render_body_to_pdf",
                 side_effect=RuntimeError("pango blew up"),
             ), \
             patch.object(consumer, "post_render_failed", return_value=True) as fail, \
             patch.object(consumer, "post_render") as ok:
            consumer.process_renders(dry_run=False)
        ok.assert_not_called()
        fail.assert_not_called()

    def test_success_still_posts_render(self):
        """Happy path unchanged: body → PDF → POST /render."""
        with patch.object(consumer, "pull_render_pending", return_value=self._rows()), \
             patch.object(consumer, "fetch_original_bytes", return_value=b"<html>x</html>"), \
             patch("render_email_body.render_body_to_pdf", return_value=b"%PDF-1.4"), \
             patch.object(consumer, "post_render_failed", return_value=True) as fail, \
             patch.object(consumer, "post_render") as ok:
            consumer.process_renders(dry_run=False)
        ok.assert_called_once_with("rid-1", b"%PDF-1.4", "application/pdf")
        fail.assert_not_called()

    def test_unconfirmed_report_never_claims_terminal_nor_retryable(self):
        """R3: an UNCONFIRMED report (transport loss / non-2xx) must not log
        a terminal claim NOR assert the row stays retryable — the commit
        outcome is unknown (a committed report stops re-rendering). The log
        must say unconfirmed and point at the dashboard."""
        import contextlib
        import io

        def permanent_render(body, content_type):
            raise PermanentRenderError("WeasyPrint produced an empty PDF")

        with patch.object(consumer, "pull_render_pending", return_value=self._rows()), \
             patch.object(consumer, "fetch_original_bytes", return_value=b"<html>x</html>"), \
             patch("render_email_body.render_body_to_pdf", side_effect=permanent_render), \
             patch.object(consumer, "post_render_failed", return_value=False), \
             patch.object(consumer, "post_render"):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                consumer.process_renders(dry_run=False)
        log = err.getvalue()
        self.assertIn("fail-perm-unreported", log)
        self.assertIn("unconfirmed", log)
        # No terminal claim, and no blanket retryability claim either.
        self.assertNotIn("terminal until Retry render", log)
        self.assertNotIn("still retryable", log)
        self.assertNotIn("re-attempt next cycle", log)

    def test_terminal_claim_logged_when_report_accepted(self):
        # Accepted (2xx) is the only outcome that licenses the terminal claim.
        import contextlib
        import io

        def permanent_render(body, content_type):
            raise PermanentRenderError("WeasyPrint produced an empty PDF")

        with patch.object(consumer, "pull_render_pending", return_value=self._rows()), \
             patch.object(consumer, "fetch_original_bytes", return_value=b"<html>x</html>"), \
             patch("render_email_body.render_body_to_pdf", side_effect=permanent_render), \
             patch.object(consumer, "post_render_failed", return_value=True), \
             patch.object(consumer, "post_render"):
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                consumer.process_renders(dry_run=False)
        self.assertIn("terminal until Retry render", err.getvalue())


class TestPostRenderFailed(unittest.TestCase):
    def test_transport_failure_is_swallowed_and_reports_failure(self):
        """A network failure posting the report must not raise — and must
        return False so the caller never logs a terminal claim (N2)."""
        import requests
        with patch.object(
            consumer.requests,
            "post",
            side_effect=requests.ConnectionError("down"),
        ):
            accepted = consumer.post_render_failed("rid-1", "empty")
        self.assertFalse(accepted)

    def test_http_503_is_not_accepted(self):
        """503 from the endpoint → False (nothing was committed)."""
        import requests
        resp = requests.Response()
        resp.status_code = 503
        with patch.object(consumer.requests, "post", return_value=resp):
            accepted = consumer.post_render_failed("rid-1", "empty")
        self.assertFalse(accepted)

    def test_http_200_is_accepted(self):
        import requests
        resp = requests.Response()
        resp.status_code = 200
        with patch.object(consumer.requests, "post", return_value=resp):
            accepted = consumer.post_render_failed("rid-1", "empty")
        self.assertTrue(accepted)

    def test_posts_to_render_failed_endpoint_with_reason(self):
        with patch.object(consumer.requests, "post") as post:
            consumer.post_render_failed("rid-1", "empty body")
        post.assert_called_once()
        url = post.call_args[0][0]
        self.assertTrue(url.endswith("/rid-1/render-failed"))
        self.assertEqual(post.call_args[1]["json"], {"reason": "empty body"})
        self.assertIn("x-receipts-processor-key", post.call_args[1]["headers"])


if __name__ == "__main__":
    unittest.main()
