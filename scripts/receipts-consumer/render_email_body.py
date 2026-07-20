"""ADR 0011 Phase B — render an email_body receipt's raw HTML/text body to a
PDF the MLX extraction pipeline can OCR (scripts/receipts-consumer side).

Security model (LOAD-BEARING — receipts@ is a public, unauthenticated address,
so the body is fully attacker-controlled):

  1. NO network access during render. WeasyPrint's ``url_fetcher`` is replaced
     with a disabled stub that satisfies every resource request from an empty
     in-memory blob and NEVER makes a network call. An attacker cannot induce
     the render process to fetch any URL (SSRF). ``test_render_email_body.py``
     hard-gates this with a live canary HTTP server: if the renderer can be made
     to fetch a URL from the body, the test fails and the renderer is NOT done.
  2. NO JavaScript engine. WeasyPrint is a CSS/PDF renderer; embedded
     ``<script>`` never executes. (Defense in depth: we strip it anyway.)
  3. Tag stripping + remote-URL neutralization BEFORE render, on top of (1)/(2).

WeasyPrint is lazy-imported inside ``render_body_to_pdf`` so ``--help`` and the
sanitizer-only unit tests work without it (and without its pango/cairo libs).
"""
from __future__ import annotations

import re

# Tags stripped entirely (contents too). WeasyPrint has no JS engine, so these
# are inert anyway — stripped for defense in depth and to keep output clean.
_STRIP_TAG_PAIRS = ("script", "iframe", "object", "embed", "noscript")
_TAG_ALT = "|".join(_STRIP_TAG_PAIRS)
_STRIP_TAG_PAIR_RE = re.compile(
    rf"<(?:{_TAG_ALT})\b[^>]*>.*?</(?:{_TAG_ALT})\s*>",
    re.IGNORECASE | re.DOTALL,
)
# Void/orphan instances the pair regex missed: bare <script ...>, <embed ...>,
# external <link>/<meta> stylesheets, dangling open tags.
_STRIP_VOID_RE = re.compile(
    r"<(?:script|iframe|object|embed|link|meta|noscript)\b[^>]*/?>",
    re.IGNORECASE,
)
# Remote src/href (http://, https://, or protocol-relative //). Replaced with
# "#". data: URIs (inline bytes already present) and relative URLs (no base_url
# passed to WeasyPrint, so they can't resolve to a fetch) are left intact.
_REMOTE_URL_RE = re.compile(
    r"""((?:src|href)\s*=\s*["'])(?:https?:)?//[^"']*(["'])""",
    re.IGNORECASE,
)
# CSS url(...) pointing at a remote resource.
_REMOTE_CSS_URL_RE = re.compile(
    r"url\(\s*['\"]?(?:https?:)?//[^)'\"]*['\"]?\s*\)",
    re.IGNORECASE,
)


def sanitize_email_html(html: str) -> str:
    """Strip script/iframe/object/embed/link/meta and neutralize remote
    src/href and CSS url(...). Pure (regex, no parser dep).

    NOTE: this is defense in depth. The authoritative no-network / no-JS
    guarantees are WeasyPrint's missing JS engine and the disabled
    ``url_fetcher`` in ``render_body_to_pdf`` — not this sanitizer. Regex
    sanitization can be evaded by malformed markup; the fetcher/JS guarantees
    cannot.
    """
    out = _STRIP_TAG_PAIR_RE.sub("", html)
    out = _STRIP_VOID_RE.sub("", out)
    out = _REMOTE_URL_RE.sub(lambda m: f"{m.group(1)}#{m.group(2)}", out)
    out = _REMOTE_CSS_URL_RE.sub("url()", out)
    return out


def disabled_url_fetcher(url, timeout=10, ssl_context=None):  # noqa: ARG001
    """WeasyPrint ``url_fetcher`` that satisfies EVERY resource request from an
    empty in-memory stub and NEVER makes a network call.

    This is the SSRF boundary. WeasyPrint resolves all external URLs (images,
    stylesheets, fonts, CSS url(...) targets) through this hook; by returning a
    stub synchronously we guarantee no socket is ever opened to an
    attacker-specified URL. The resource simply renders as nothing, which is
    fine — external images/CSS in a receipt body are non-essential, and inline
    (data:) resources are decoded by WeasyPrint without calling the fetcher.
    """
    return {"string": b"", "mime_type": "application/octet-stream"}


def render_body_to_pdf(body: str, content_type: str) -> bytes:
    """Render an email body (``text/html`` or ``text/plain``) to a PDF.

    ``text/plain`` is escaped and wrapped in a ``<pre>`` so whitespace/line
    breaks survive. HTML is sanitized first. WeasyPrint is imported lazily;
    raises on render error or an empty result.
    """
    from weasyprint import HTML  # lazy: keeps --help + sanitizer tests cheap

    ct = (content_type or "").lower()
    if "html" in ct:
        html_doc = sanitize_email_html(body)
    else:
        escaped = (
            body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        )
        html_doc = (
            "<html><head><meta charset='utf-8'></head><body>"
            "<pre style='white-space: pre-wrap; font-family: sans-serif;'>"
            f"{escaped}</pre></body></html>"
        )

    pdf = HTML(string=html_doc, url_fetcher=disabled_url_fetcher).write_pdf()
    if not pdf:
        raise RuntimeError("WeasyPrint produced an empty PDF")
    return pdf
