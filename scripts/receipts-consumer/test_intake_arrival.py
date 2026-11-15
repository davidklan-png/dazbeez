"""Offline actual candidate SELECT + TS-shared parity fixtures; no consumer init.

Extract unchanged functions by AST to avoid credentials, MLX, subprocesses and
network initialization. Every query runs against SQLite with all migrations.
"""
import ast
import json
import re
import sqlite3
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = json.loads((ROOT / "tests/fixtures/intake-arrival-times.json").read_text())


class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 11, 15, 12, 0, 2, tzinfo=timezone.utc).astimezone(tz)


class IntakeArrivalTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        for file in sorted((ROOT / "db/receipts").glob("*.sql")):
            self.db.executescript(file.read_text())
        tree = ast.parse((ROOT / "scripts/receipts-consumer/consumer.py").read_text())
        names = {"parse_intake_time", "is_auto_promote_eligible", "pull_auto_promote_candidates", "_sql_escape"}
        nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        self.assertEqual(len(nodes), len(names))
        self.ns = {"datetime": Clock, "timezone": timezone, "re": re, "Any": Any,
                   "_d1_query": lambda sql: [dict(r) for r in self.db.execute(sql)]}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), "actual-consumer-policy", "exec"), self.ns)

    def tearDown(self):
        self.db.close()

    def insert(self, ident="fixture", arrival="2026-11-15T12:00:01Z", **overrides):
        row = dict(id=ident, arrived_at=arrival, received_at="2099-01-01T00:00:00Z", created_at="2026-11-15T12:00:02Z",
                   from_address="fixture@example.invalid", spf_pass=1, dkim_pass=1, body_text="Receipt")
        row.update(overrides)
        self.db.execute(f"INSERT INTO email_receipt_intake ({','.join(row)}) VALUES ({','.join('?' for _ in row)})", list(row.values()))

    def test_candidate_controls_and_only_id(self):
        trusted = {"fixture@example.invalid": "2026-11-15T12:00:01Z"}
        self.insert("eligible", received_at="1900-01-01T00:00:00Z")
        self.insert("equal-offset", arrival="2026-11-15T21:00:01+09:00")
        for ident, kwargs in [
            ("attachment", dict(attachment_r2_key="key")),
            ("original-attachment", dict(attachment_filename="expired.pdf")),
            ("no-body", dict(body_text=None)),
            ("rejected", dict(status="rejected")), ("promoted", dict(status="promoted")),
            ("spf-fail", dict(spf_pass=0)), ("dkim-fail", dict(dkim_pass=0)),
            ("untrusted", dict(from_address="stranger@example.invalid")),
            ("before-trust", dict(arrival="2026-11-15T12:00:00Z")),
            ("legacy", dict(arrival=None)),
        ]:
            self.insert(ident, **kwargs)
        candidates = self.ns["pull_auto_promote_candidates"]
        self.assertEqual([r["id"] for r in candidates(trusted, set())], ["eligible", "equal-offset"])
        self.assertEqual([r["id"] for r in candidates(trusted, set(), "eligible")], ["eligible"])
        self.assertEqual(candidates(trusted, {"fixture@example.invalid"}), [])
        self.assertEqual(candidates({}, set()), [])


def parity_case(case):
    def run(self):
        self.insert(arrival=case["arrival"])
        self.assertEqual(self.ns["parse_intake_time"](case["arrival"]) is not None, case["valid"])
        candidates = self.ns["pull_auto_promote_candidates"]({"fixture@example.invalid": case["trust"]}, set())
        self.assertEqual(bool(candidates), case["eligible"])
    return run


for case in FIXTURES:
    setattr(IntakeArrivalTests, "test_parity_" + case["name"].replace("-", "_"), parity_case(case))

if __name__ == "__main__":
    unittest.main()
