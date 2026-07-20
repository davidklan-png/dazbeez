"""Tests for render_email_body (ADR 0011 Phase B).

The SSRF canary (``test_ssrf_canary``) is a HARD GATE: receipts@ is a public
address and the body is attacker-controlled, so if the renderer can be made to
fetch ANY URL from the body, the test fails and the renderer is NOT done — do
not weaken the renderer to make it pass.

Run:
  cd scripts/receipts-consumer && \\
  .venv/bin/python3 -m unittest test_render_email_body -v
"""
from __future__ import annotations

import http.server
import os
import socketserver
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from render_email_body import sanitize_email_html, render_body_to_pdf  # noqa: E402


class SanitizerTests(unittest.TestCase):
    def test_strips_dangerous_tags(self):
        html = (
            "<p>ok</p>"
            "<script>alert(1)</script>"
            "<iframe src='x'></iframe>"
            "<object data='y'></object>"
            "<embed src='z'>"
            "<noscript>fallback</noscript>"
        )
        out = sanitize_email_html(html)
        low = out.lower()
        self.assertNotIn("<script", low)
        self.assertNotIn("<iframe", low)
        self.assertNotIn("<object", low)
        self.assertNotIn("<embed", low)
        self.assertNotIn("<noscript", low)
        self.assertIn("<p>ok</p>", out)

    def test_strips_external_link_and_meta(self):
        html = (
            "<link rel='stylesheet' href='https://evil.com/x.css'>"
            "<meta http-equiv='refresh' content='0;url=https://evil.com'>"
        )
        out = sanitize_email_html(html)
        low = out.lower()
        self.assertNotIn("<link", low)
        self.assertNotIn("<meta", low)

    def test_neutralizes_remote_src_and_href(self):
        html = (
            "<img src='https://evil.com/a.png'>"
            "<a href='http://evil.com/b'>click</a>"
            "<img src='//evil.com/c.png'>"
        )
        out = sanitize_email_html(html)
        self.assertNotIn("evil.com", out, f"remote host survived: {out!r}")
        self.assertTrue("src='#'" in out or 'src="#"' in out)
        self.assertTrue("href='#'" in out or 'href="#"' in out)

    def test_neutralizes_remote_css_url(self):
        html = "<style>body { background: url('https://evil.com/bg.png'); }</style>"
        out = sanitize_email_html(html)
        self.assertNotIn("evil.com", out)
        self.assertNotIn("url('https", out)
        self.assertNotIn("url(http", out)
        self.assertNotIn("url(//", out)

    def test_preserves_data_and_relative_urls(self):
        html = "<img src='data:image/png;base64,iVBORw0KGgo='><img src='inline.png'>"
        out = sanitize_email_html(html)
        self.assertIn("data:image/png;base64,iVBORw0KGgo=", out)
        self.assertIn("inline.png", out)


class RenderTests(unittest.TestCase):
    def test_plain_text_produces_pdf(self):
        pdf = render_body_to_pdf("Receipt\nTotal: 1,000 JPY\n", "text/plain")
        self.assertEqual(pdf[:4], b"%PDF")
        self.assertGreater(len(pdf), 100)

    def test_html_produces_pdf(self):
        pdf = render_body_to_pdf("<p><b>Receipt</b>: 1,000 JPY</p>", "text/html")
        self.assertEqual(pdf[:4], b"%PDF")
        self.assertGreater(len(pdf), 100)

    def test_plain_text_escapes_markup(self):
        # A text/plain body with markup-like content must be escaped, not parsed.
        pdf = render_body_to_pdf("a < b and c > d <script>x</script>", "text/plain")
        self.assertEqual(pdf[:4], b"%PDF")


class _HitRecordingHandler(http.server.BaseHTTPRequestHandler):
    hits: list[str] = []

    def do_GET(self):
        type(self).hits.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"x")

    def log_message(self, *args):  # silence the test server
        pass


class SsrfCanaryTest(unittest.TestCase):
    """HARD GATE: render a body referencing a live local canary server via
    every resource channel WeasyPrint supports. The renderer MUST produce a PDF
    AND the canary server MUST record zero hits — no fetch may occur."""

    def test_ssrf_canary_no_external_fetch_during_render(self):
        _HitRecordingHandler.hits = []
        with socketserver.TCPServer(("127.0.0.1", 0), _HitRecordingHandler) as httpd:
            port = httpd.server_address[1]
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                canary = f"http://127.0.0.1:{port}"
                malicious = f"""
                <html><head>
                  <link rel='stylesheet' href='{canary}/evil.css'>
                  <style>
                    body {{ background-image: url('{canary}/bg.png'); }}
                    .x {{ content: url('{canary}/cssurl.png'); }}
                  </style>
                </head><body>
                  <img src='{canary}/track.png'>
                  <img src='{canary}/second.png'>
                  <p>Receipt body &mdash; legitimate content</p>
                  <object data='{canary}/swf'></object>
                  <iframe src='{canary}/iframe.html'></iframe>
                </body></html>
                """
                pdf = render_body_to_pdf(malicious, "text/html")
                # Give any (must-not-exist) in-flight fetch a moment to register.
                time.sleep(0.3)
            finally:
                httpd.shutdown()
                thread.join(timeout=2)

        self.assertEqual(pdf[:4], b"%PDF", "render must still succeed without external resources")
        self.assertGreater(len(pdf), 100)
        self.assertEqual(
            _HitRecordingHandler.hits,
            [],
            f"SSRF FAIL — renderer fetched canary URLs {_HitRecordingHandler.hits!r}; "
            "the no-network url_fetcher boundary is broken",
        )


if __name__ == "__main__":
    unittest.main()
