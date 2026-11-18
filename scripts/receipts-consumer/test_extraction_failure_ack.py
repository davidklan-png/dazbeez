"""Offline actual reporter + queue/backfill caller regressions; no real I/O."""
from __future__ import annotations

import contextlib
import io
import json
import os
import unittest
from unittest.mock import patch

for key in ("CF_ACCOUNT_ID", "CF_QUEUE_ID", "CF_API_TOKEN", "RECEIPTS_PROCESSOR_KEY", "MLX_MODEL"):
    os.environ.setdefault(key, "d")
os.environ.setdefault("RECEIPTS_EXTRACT_URL", "http://d")

import requests
import consumer


def response(status, body):
    res = requests.Response()
    res.status_code = status
    res._content = json.dumps(body).encode()
    return res


# Each matrix row is also run through process_once with the REAL reporter and
# ack() function. Only HTTP and local extraction are replaced.
CASES = [
    ("recorded", 200, {"ok": True, "extractionState": "failed"}, True),
    ("repeat", 200, {"ok": True, "extractionState": "failed", "alreadyRecorded": True}, True),
    ("processed_won", 200, {"ok": True, "extractionState": "processed", "alreadyHandled": True}, True),
    ("definitive_404", 404, {"outcome": "not_found", "error": "Receipt not found."}, True),
    ("generic_404", 404, {"error": "Not found"}, False),
    ("refused_409", 409, {"outcome": "refused", "error": "check state"}, False),
    ("generic_409", 409, {"error": "locked"}, False),
    ("500", 500, {"ok": True, "extractionState": "failed"}, False),
    ("401", 401, {"error": "Unauthorized"}, False),
    ("400", 400, {"error": "Bad reason"}, False),
    ("unknown_state", 200, {"ok": True, "extractionState": "queued"}, False),
    ("false_ok", 200, {"ok": False, "extractionState": "failed"}, False),
    ("truthy_ok", 200, {"ok": 1, "extractionState": "failed"}, False),
    ("missing_state", 200, {"ok": True}, False),
    ("array", 200, ["failed"], False),
    ("null", 200, None, False),
    ("non_json", 200, ValueError("HTML response"), False),
    ("network", 0, requests.ConnectionError("network down"), False),
    ("lost_report_ack", 0, requests.Timeout("response lost after possible commit"), False),
]


def report_result(status, body):
    if isinstance(body, requests.RequestException):
        raise body
    res = response(status, None if isinstance(body, Exception) else body)
    if isinstance(body, ValueError):
        res._content = b"<html>not JSON</html>"
    return res


class TestReporter(unittest.TestCase):
    def test_http_and_transport_matrix(self):
        for name, status, body, confirmed in CASES:
            with self.subTest(name=name), \
                 patch.object(consumer.requests, "post", side_effect=lambda *a, **k: report_result(status, body)), \
                 contextlib.redirect_stderr(io.StringIO()) as log:
                self.assertIs(consumer.post_extraction_failed("r1", "reason"), confirmed)
                if not confirmed:
                    self.assertIn("unconfirmed", log.getvalue())
                    self.assertIn("current state", log.getvalue())
                    self.assertNotIn("acking anyway", log.getvalue())
                    self.assertNotIn("not modified", log.getvalue())

    def test_request_contract_preserves_model_and_truncation(self):
        with patch.object(consumer.requests, "post", return_value=response(200, {"ok": True, "extractionState": "failed"})) as post:
            self.assertTrue(consumer.post_extraction_failed("r1", "x" * 1200))
        args, kwargs = post.call_args
        self.assertEqual(args, (f"{consumer.EXTRACT_BASE}/r1/extraction-failed",))
        self.assertEqual(kwargs["json"], {"reason": "x" * 1000, "model": f"mlx_local:{consumer.MLX_MODEL.split('/')[-1]}"})
        self.assertEqual(kwargs["headers"]["x-receipts-processor-key"], consumer.PROCESSOR_KEY)
        self.assertEqual(kwargs["timeout"], 30)


class TestQueueAck(unittest.TestCase):
    def message(self, rid="r1", lease="lease1"):
        return {"id": rid, "lease_id": lease, "body": {"receiptId": rid, "r2Key": "key"}}

    def test_actual_queue_ack_matrix(self):
        for name, status, body, confirmed in CASES:
            ack_requests = []

            def http(url, **kwargs):
                if url.endswith("/extraction-failed"):
                    return report_result(status, body)
                self.assertTrue(url.endswith("/ack"))
                ack_requests.append(kwargs["json"])
                return response(200, {})

            with self.subTest(name=name), \
                 patch.object(consumer, "pull_batch", return_value=[self.message()]), \
                 patch.object(consumer, "fetch_images", side_effect=consumer.PermanentExtractionFailure("corrupt")), \
                 patch.object(consumer.requests, "post", side_effect=http), \
                 contextlib.redirect_stderr(io.StringIO()) as log:
                self.assertEqual(consumer.process_once(), 1 if confirmed else 0)
                self.assertEqual(ack_requests, [{"acks": [{"lease_id": "lease1"}]}] if confirmed else [])
                if not confirmed:
                    self.assertIn("leaving unacked", log.getvalue())
                    self.assertNotIn("marked extraction-failed", log.getvalue())

    def test_mixed_batch_only_acks_confirmed_lease(self):
        sent = []

        def http(url, **kwargs):
            if url.endswith("/r1/extraction-failed"):
                return response(200, {"ok": True, "extractionState": "failed"})
            if url.endswith("/r2/extraction-failed"):
                return response(500, {"error": "unconfirmed"})
            sent.append(kwargs["json"])
            return response(200, {})

        with patch.object(consumer, "pull_batch", return_value=[self.message(), self.message("r2", "lease2")]), \
             patch.object(consumer, "fetch_images", side_effect=consumer.PermanentExtractionFailure("corrupt")), \
             patch.object(consumer.requests, "post", side_effect=http), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(consumer.process_once(), 1)
        self.assertEqual(sent, [{"acks": [{"lease_id": "lease1"}]}])

    def test_lost_queue_ack_can_redeliver_and_confirm_first_terminal_result(self):
        posts = []
        attempts = 0

        def http(url, **kwargs):
            nonlocal attempts
            posts.append((url, kwargs["json"]))
            if url.endswith("/extraction-failed"):
                return response(200, {"ok": True, "extractionState": "failed", "alreadyRecorded": attempts > 0})
            attempts += 1
            if attempts == 1:
                raise requests.Timeout("queue ACK response lost after possible acceptance")
            return response(200, {})

        with patch.object(consumer, "pull_batch", return_value=[self.message()]), \
             patch.object(consumer, "fetch_images", side_effect=consumer.PermanentExtractionFailure("corrupt")), \
             patch.object(consumer.requests, "post", side_effect=http), \
             contextlib.redirect_stderr(io.StringIO()) as log:
            with self.assertRaises(requests.Timeout):
                consumer.process_once()
            self.assertEqual(consumer.process_once(), 1)
        self.assertEqual(len(posts), 4)
        self.assertEqual(posts[1][1], posts[3][1])
        self.assertNotIn("+ acked", log.getvalue())

    def test_transient_extraction_error_never_posts_failure_or_acks(self):
        with patch.object(consumer, "pull_batch", return_value=[self.message()]), \
             patch.object(consumer, "fetch_images", side_effect=RuntimeError("model unavailable")), \
             patch.object(consumer.requests, "post") as post, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(consumer.process_once(), 0)
        post.assert_not_called()


class TestBackfill(unittest.TestCase):
    def test_actual_reporter_controls_truthful_backfill_log(self):
        for name, status, body, confirmed in CASES:
            with self.subTest(name=name), \
                 patch.object(consumer, "pull_pending_rows", return_value=[{
                     "id": "r1", "status": "captured", "extraction_state": "queued", "original_r2_key": "key",
                 }]), \
                 patch.object(consumer, "_load_model"), \
                 patch.object(consumer, "fetch_images", side_effect=consumer.PermanentExtractionFailure("corrupt")), \
                 patch.object(consumer.requests, "post", side_effect=lambda *a, **k: report_result(status, body)), \
                 contextlib.redirect_stderr(io.StringIO()) as log, \
                 contextlib.redirect_stdout(io.StringIO()):
                consumer.process_backfill(dry_run=False)
                if confirmed:
                    self.assertIn("terminal or already handled confirmed", log.getvalue())
                else:
                    self.assertIn("report unconfirmed", log.getvalue())
                    self.assertNotIn("marked extraction-failed", log.getvalue())


if __name__ == "__main__":
    unittest.main()
