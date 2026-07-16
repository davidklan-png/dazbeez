#!/usr/bin/env python3
"""Unit tests for audit_queue_config.py and the consumer.py policy import.

Standard library only (unittest + unittest.mock). No real network calls: the
single GET is mocked at audit_queue_config._fetch.
"""
from __future__ import annotations

import io
import json
import os
import unittest
import unittest.mock as mock
import urllib.error

import audit_queue_config as aqc
import queue_policy as qp

CONSUMER_DIR = os.path.dirname(os.path.abspath(__file__))

# Canaries that must NEVER appear in any verifier output.
TOK = "tok_SECRET_TOKEN_ABC"
ACCT = "acct_SECRET_ACCOUNT_ID"
QID = "qid_SECRET_QUEUE_ID"
CID = "cid_SECRET_CONSUMER_ID"


def good_consumer():
    """A consumer dict that matches policy on all seven fields, plus
    identifier fields that must never be printed."""
    return {
        "type": qp.EXPECTED_CONSUMER_TYPE,
        "queue_name": qp.PRIMARY_QUEUE_NAME,
        "dead_letter_queue": qp.DEAD_LETTER_QUEUE_NAME,
        "settings": {
            "batch_size": qp.EXPECTED_CONSUMER_BATCH_SIZE,
            "max_retries": qp.EXPECTED_CONSUMER_MAX_RETRIES,
            "retry_delay": qp.EXPECTED_CONSUMER_RETRY_DELAY,
            "visibility_timeout_ms": qp.EXPECTED_CONSUMER_VISIBILITY_TIMEOUT_MS,
        },
        # identifiers — must be redacted from output
        "consumer_id": CID,
        "queue_id": QID,
    }


def envelope_bytes(result):
    return json.dumps({"success": True, "errors": [], "messages": [], "result": result}).encode()


def run_with(body_bytes=None, side_effect=None, env=None):
    """Invoke aqc.run() with _fetch mocked and env controlled.

    Returns (exit_code, stdout, stderr, fetch_mock)."""
    if env is None:
        env = {"CF_ACCOUNT_ID": ACCT, "CF_QUEUE_ID": QID, "CF_API_TOKEN": TOK}
    with mock.patch.dict(os.environ, env, clear=True), \
            mock.patch.object(aqc, "_fetch") as m:
        if side_effect is not None:
            m.side_effect = side_effect
        else:
            m.return_value = (200, body_bytes)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdout", out), mock.patch("sys.stderr", err):
            code = aqc.run()
    return code, out.getvalue(), err.getvalue(), m


class CompareAndFormat(unittest.TestCase):
    def test_exact_match_table(self):
        rows = aqc.compare(good_consumer())
        self.assertEqual(len(rows), 7)
        self.assertTrue(all(is_match for *_u, is_match in rows))
        table = aqc.format_table(rows)
        self.assertIn("| MATCH", table)
        self.assertNotIn("DRIFT", table)

    def test_format_table_has_four_columns(self):
        table = aqc.format_table(aqc.compare(good_consumer()))
        for line in table.splitlines():
            parts = line.split(" | ")
            self.assertEqual(len(parts), 4, line)

    def test_identifiers_never_in_formatted_output(self):
        consumer = good_consumer()
        # Even if a secret-looking value sat in a policy field path, only the
        # seven policy fields are read. Inject canaries in non-read spots.
        consumer["__raw"] = "RAW_" + TOK
        consumer["account_id"] = ACCT
        table = aqc.format_table(aqc.compare(consumer))
        for canary in (TOK, ACCT, QID, CID, "RAW_"):
            self.assertNotIn(canary, table)


class Drift(unittest.TestCase):
    def _drift_case(self, mutate, expected_drift_label):
        consumer = good_consumer()
        mutate(consumer)
        code, out, _err, _m = run_with(envelope_bytes([consumer]))
        self.assertEqual(code, 1, f"expected nonzero for {expected_drift_label}")
        self.assertIn("DRIFT", out)
        # the specific row shows DRIFT
        self.assertIn(f"{expected_drift_label} |", out)
        self.assertIn("DRIFT", out.split(expected_drift_label)[1].splitlines()[0])

    def test_type_drift(self):
        self._drift_case(lambda c: c.update(type="worker"), "type")

    def test_queue_name_drift(self):
        self._drift_case(lambda c: c.update(queue_name="other-queue"), "queue_name")

    def test_dead_letter_queue_drift(self):
        self._drift_case(lambda c: c.update(dead_letter_queue=None), "dead_letter_queue")

    def test_batch_size_drift(self):
        self._drift_case(lambda c: c["settings"].update(batch_size=99), "settings.batch_size")

    def test_max_retries_drift(self):
        self._drift_case(lambda c: c["settings"].update(max_retries=1), "settings.max_retries")

    def test_retry_delay_drift(self):
        self._drift_case(lambda c: c["settings"].update(retry_delay=7), "settings.retry_delay")

    def test_visibility_timeout_drift(self):
        self._drift_case(
            lambda c: c["settings"].update(visibility_timeout_ms=1000),
            "settings.visibility_timeout_ms",
        )

    def test_missing_settings_object_is_drift_not_defaulted(self):
        consumer = good_consumer()
        del consumer["settings"]
        code, out, _e, _m = run_with(envelope_bytes([consumer]))
        self.assertEqual(code, 1)
        # all four settings.* rows render <missing>, none silently match
        for label in ("settings.batch_size", "settings.max_retries",
                      "settings.retry_delay", "settings.visibility_timeout_ms"):
            line = next(l for l in out.splitlines() if l.startswith(label + " |"))
            self.assertTrue(line.endswith("<missing> | DRIFT"), line)

    def test_single_missing_setting_is_drift(self):
        consumer = good_consumer()
        del consumer["settings"]["batch_size"]
        code, out, _e, _m = run_with(envelope_bytes([consumer]))
        self.assertEqual(code, 1)
        line = next(l for l in out.splitlines() if l.startswith("settings.batch_size |"))
        self.assertTrue(line.endswith("<missing> | DRIFT"), line)


class ConsumerCountAndShape(unittest.TestCase):
    def test_exact_match_exits_zero(self):
        code, out, _e, _m = run_with(envelope_bytes([good_consumer()]))
        self.assertEqual(code, 0)
        self.assertEqual(out.count("MATCH"), 7)
        self.assertNotIn("DRIFT", out)

    def test_zero_consumers(self):
        code, _o, err, _m = run_with(envelope_bytes([]))
        self.assertNotEqual(code, 0)
        self.assertIn("found 0", err)

    def test_multiple_consumers(self):
        code, _o, err, _m = run_with(envelope_bytes([good_consumer(), good_consumer()]))
        self.assertNotEqual(code, 0)
        self.assertIn("found 2", err)

    def test_wrong_consumer_type_reports_drift(self):
        consumer = good_consumer()
        consumer["type"] = "worker"
        code, out, _e, _m = run_with(envelope_bytes([consumer]))
        self.assertNotEqual(code, 0)
        type_line = next(l for l in out.splitlines() if l.startswith("type |"))
        # mismatching string renders <different>, never the live value
        self.assertTrue(type_line.endswith("<different> | DRIFT"), type_line)

    def test_result_not_a_list(self):
        code, _o, err, _m = run_with(envelope_bytes({"not": "a list"}))
        self.assertNotEqual(code, 0)
        self.assertIn("malformed result", err)

    def test_success_false_is_error(self):
        body = json.dumps({"success": False, "errors": [{"code": 1234}], "result": []}).encode()
        code, _o, err, _m = run_with(body)
        self.assertNotEqual(code, 0)
        self.assertIn("success=false", err)

    def test_consumer_not_a_dict(self):
        code, _o, err, _m = run_with(envelope_bytes(["not-a-dict"]))
        self.assertNotEqual(code, 0)
        self.assertIn("malformed consumer", err)

    def test_malformed_json(self):
        code, _o, err, _m = run_with(b"not json {")
        self.assertNotEqual(code, 0)
        self.assertIn("malformed JSON", err)


class SafetyAndUrl(unittest.TestCase):
    def test_missing_environment_exits_nonzero(self):
        code, _o, err, _m = run_with(envelope_bytes([good_consumer()]),
                                     env={"CF_ACCOUNT_ID": ACCT})  # missing CF_QUEUE_ID + CF_API_TOKEN
        self.assertNotEqual(code, 0)
        # reports which names are missing, never their values
        self.assertIn("missing environment", err)
        self.assertNotIn(TOK, err)

    def test_http_error_does_not_print_body(self):
        canary = "CANARY_RESPONSE_BODY"
        fp = io.BytesIO(canary.encode())
        http_err = urllib.error.HTTPError(
            "https://example.invalid", 500, "Server Error", {}, fp
        )
        code, _o, err, _m = run_with(side_effect=http_err)
        self.assertNotEqual(code, 0)
        self.assertIn("HTTP 500", err)
        self.assertNotIn(canary, err)

    def test_consumers_url_is_metadata_endpoint(self):
        url = aqc.consumers_url(ACCT, QID)
        self.assertTrue(url.endswith("/consumers"))
        self.assertNotIn("/messages/", url)

    def test_run_hits_consumers_endpoint_not_messages(self):
        code, _o, _e, m = run_with(envelope_bytes([good_consumer()]))
        self.assertEqual(code, 0)
        called_url = m.call_args[0][0]
        self.assertTrue(called_url.endswith("/consumers"), called_url)
        self.assertNotIn("/messages/", called_url)

    def test_token_sent_only_in_header_never_returned(self):
        code, out, err, m = run_with(envelope_bytes([good_consumer()]))
        self.assertEqual(code, 0)
        # token was passed to _fetch as the 2nd arg (header), not in the URL
        called_url, called_token = m.call_args[0]
        self.assertNotIn(TOK, called_url)
        self.assertEqual(called_token, TOK)
        # and never appears in output
        self.assertNotIn(TOK, out)
        self.assertNotIn(TOK, err)
        # account/queue ids are path components of the URL but never printed
        self.assertNotIn(ACCT, out + err)
        self.assertNotIn(QID, out + err)
        self.assertNotIn(CID, out + err)


class ConsumerImportsPolicy(unittest.TestCase):
    """consumer.py must source its runtime constants from queue_policy (no
    behavior change), without needing to import the heavy consumer module."""

    def test_consumer_imports_policy_under_historical_names(self):
        with open(os.path.join(CONSUMER_DIR, "consumer.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("from queue_policy import", src)
        self.assertIn("MAC_PER_PULL_BATCH_SIZE as BATCH_SIZE", src)
        self.assertIn("MAC_PER_PULL_VISIBILITY_TIMEOUT_MS as VISIBILITY_TIMEOUT_MS", src)
        self.assertIn("MAC_POLL_INTERVAL_S as POLL_INTERVAL_S", src)
        # the old literal assignments must be gone
        for stale in ("BATCH_SIZE = 10", "VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000",
                      "POLL_INTERVAL_S = 20"):
            self.assertNotIn(stale, src, f"stale literal still present: {stale}")


class Hardening(unittest.TestCase):
    """Strict type validation, bounded-placeholder rendering, and the redacted
    exception boundary."""

    def _set_field(self, consumer, label, value):
        if label.startswith("settings."):
            consumer.setdefault("settings", {})[label.split(".", 1)[1]] = value
        else:
            consumer[label] = value
        return consumer

    def test_retry_delay_false_is_drift_not_match(self):
        # bool is an int subclass; False must NOT match expected integer 0.
        consumer = good_consumer()
        consumer["settings"]["retry_delay"] = False
        code, out, _e, _m = run_with(envelope_bytes([consumer]))
        self.assertEqual(code, 1)
        line = next(l for l in out.splitlines() if l.startswith("settings.retry_delay |"))
        self.assertTrue(line.endswith("<invalid-type> | DRIFT"), line)
        row = next(r for r in aqc.compare(consumer) if r[0] == "settings.retry_delay")
        self.assertFalse(row[3])

    def test_bool_rejected_for_every_numeric_field(self):
        for label in sorted(aqc.NUMERIC_FIELDS):
            consumer = good_consumer()
            self._set_field(consumer, label, True)
            code, out, _e, _m = run_with(envelope_bytes([consumer]))
            self.assertEqual(code, 1, label)
            line = next(l for l in out.splitlines() if l.startswith(label + " |"))
            self.assertTrue(line.endswith("<invalid-type> | DRIFT"), (label, line))

    def test_containers_render_invalid_type_and_redact_canary(self):
        canary = "NESTED_RAW_CANARY"
        for label, _expected in aqc.FIELDS:
            for bad in ({"raw_response_canary": canary}, [canary]):
                consumer = good_consumer()
                self._set_field(consumer, label, bad)
                code, out, _e, _m = run_with(envelope_bytes([consumer]))
                self.assertEqual(code, 1, (label, bad))
                line = next(l for l in out.splitlines() if l.startswith(label + " |"))
                self.assertTrue(line.endswith("<invalid-type> | DRIFT"), (label, line))
                self.assertNotIn(canary, out)

    def test_mismatching_string_redacts_canaries(self):
        for label in ("type", "queue_name", "dead_letter_queue"):
            for canary in (TOK, ACCT, QID, CID):
                consumer = good_consumer()
                self._set_field(consumer, label, "x-" + canary + "-y")
                code, out, _e, _m = run_with(envelope_bytes([consumer]))
                self.assertEqual(code, 1, (label, canary))
                line = next(l for l in out.splitlines() if l.startswith(label + " |"))
                self.assertTrue(line.endswith("<different> | DRIFT"), (label, line))
                self.assertNotIn(canary, out)

    def test_control_chars_cannot_inject_rows(self):
        consumer = good_consumer()
        consumer["queue_name"] = (
            "a\nb\rc\td | INJECTED | MATCH\nfake-row | z | y | MATCH"
        )
        code, out, _e, _m = run_with(envelope_bytes([consumer]))
        self.assertEqual(code, 1)
        self.assertEqual(len(out.splitlines()), 7)  # still exactly seven rows
        self.assertNotIn("INJECTED", out)
        self.assertNotIn("fake-row", out)
        qline = next(l for l in out.splitlines() if l.startswith("queue_name |"))
        self.assertTrue(qline.endswith("<different> | DRIFT"), qline)

    def test_missing_fields_render_missing_placeholder(self):
        for label, _expected in aqc.FIELDS:
            consumer = good_consumer()
            if label.startswith("settings."):
                del consumer["settings"][label.split(".", 1)[1]]
            else:
                del consumer[label]
            code, out, _e, _m = run_with(envelope_bytes([consumer]))
            self.assertEqual(code, 1, label)
            line = next(l for l in out.splitlines() if l.startswith(label + " |"))
            self.assertTrue(line.endswith("<missing> | DRIFT"), (label, line))

    def test_unexpected_fetch_exception_is_redacted(self):
        canary = "EXC_MSG_CANARY_" + TOK
        code, out, err, _m = run_with(side_effect=RuntimeError(canary))
        self.assertNotEqual(code, 0)
        self.assertIn("unexpected network failure (RuntimeError)", err)
        self.assertNotIn(canary, err)
        self.assertNotIn(canary, out)
        self.assertNotIn("Traceback", err)

    def test_exact_match_still_seven_matches_exit_zero(self):
        code, out, _e, _m = run_with(envelope_bytes([good_consumer()]))
        self.assertEqual(code, 0)
        self.assertEqual(out.count("MATCH"), 7)
        self.assertNotIn("DRIFT", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
