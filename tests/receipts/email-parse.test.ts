// Tests for the pure helpers the receipts-email-intake Worker uses
// (lib/receipts/email-parse.ts). These are dependency-free and Worker-agnostic,
// so they live in the main suite like the rest of the receipts logic tests.
// The Worker's src/index.ts binding/IO glue (readRaw, PostalMime.parse, R2/D1)
// is covered by the live §8 mail test, not here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  withinMessageSizeCeiling,
  mapPostalAttachments,
  extractAuthVerdicts,
  pickRawHeadersSubset,
  staleCutoffIso,
  capBody,
  extractLinks,
  parseTrustedIntakeSenders,
  isAutoPromoteEligible,
} from "@/lib/receipts/email-parse";

// ─── withinMessageSizeCeiling ───────────────────────────────────────────────

test("withinMessageSizeCeiling: under ceiling → true", () => {
  assert.equal(withinMessageSizeCeiling(0, 100), true);
  assert.equal(withinMessageSizeCeiling(99, 100), true);
});

test("withinMessageSizeCeiling: exactly at ceiling → true (boundary, <=)", () => {
  assert.equal(withinMessageSizeCeiling(100, 100), true);
});

test("withinMessageSizeCeiling: over ceiling → false", () => {
  assert.equal(withinMessageSizeCeiling(101, 100), false);
});

test("withinMessageSizeCeiling: negative / NaN / non-finite → false", () => {
  assert.equal(withinMessageSizeCeiling(-1, 100), false);
  assert.equal(withinMessageSizeCeiling(NaN, 100), false);
  assert.equal(withinMessageSizeCeiling(Infinity, 100), false);
});

// ─── mapPostalAttachments ───────────────────────────────────────────────────

test("mapPostalAttachments: maps filename/mimeType and computes sizeBytes from content", () => {
  const data = new Uint8Array([1, 2, 3, 4]).buffer;
  const [m] = mapPostalAttachments([
    { filename: "inv.pdf", mimeType: "application/pdf", content: data },
  ]);
  assert.equal(m.filename, "inv.pdf");
  assert.equal(m.contentType, "application/pdf");
  assert.equal(m.sizeBytes, 4);
  assert.ok(m.data instanceof ArrayBuffer);
  assert.equal(m.data.byteLength, 4);
});

test("mapPostalAttachments: null/empty filename → 'attachment'", () => {
  const data = new Uint8Array([1]).buffer;
  const a = mapPostalAttachments([{ filename: null, mimeType: "x", content: data }]);
  const b = mapPostalAttachments([{ filename: "   ", mimeType: "x", content: data }]);
  assert.equal(a[0].filename, "attachment");
  assert.equal(b[0].filename, "attachment");
});

test("mapPostalAttachments: empty/missing mimeType → application/octet-stream", () => {
  const data = new Uint8Array([1]).buffer;
  const m = mapPostalAttachments([{ filename: "a", mimeType: "", content: data }]);
  assert.equal(m[0].contentType, "application/octet-stream");
});

test("mapPostalAttachments: Uint8Array VIEW over a larger buffer copies only the view range", () => {
  // The correctness point: a postal-mime attachment content can be a Uint8Array
  // view over a larger backing buffer. Naively using .buffer would leak bytes
  // outside the attachment's range. The mapper must copy just [byteOffset,
  // byteOffset+byteLength).
  const backing = new Uint8Array([0, 0, 10, 20, 30, 0, 0]); // view will be [10,20,30]
  const view = backing.subarray(2, 5);
  assert.equal(view.byteLength, 3);
  const [m] = mapPostalAttachments([
    { filename: "a", mimeType: "application/pdf", content: view },
  ]);
  assert.equal(m.sizeBytes, 3, "sizeBytes reflects the VIEW, not the backing buffer");
  assert.equal(m.data.byteLength, 3);
  assert.deepEqual(Array.from(new Uint8Array(m.data)), [10, 20, 30]);
  assert.notEqual(m.data, backing.buffer, "must be a copy, not the backing buffer");
});

// ─── extractAuthVerdicts ────────────────────────────────────────────────────

test("extractAuthVerdicts: absent header → {false,false} (not a 'fail', just unavailable)", () => {
  assert.deepEqual(extractAuthVerdicts(null), { spf: false, dkim: false });
  assert.deepEqual(extractAuthVerdicts(undefined), { spf: false, dkim: false });
  assert.deepEqual(extractAuthVerdicts(""), { spf: false, dkim: false });
});

test("extractAuthVerdicts: both pass", () => {
  const h = "mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com";
  assert.deepEqual(extractAuthVerdicts(h), { spf: true, dkim: true });
});

test("extractAuthVerdicts: spf=fail, dkim=pass", () => {
  const h = "spf=fail; dkim=pass";
  assert.deepEqual(extractAuthVerdicts(h), { spf: false, dkim: true });
});

test("extractAuthVerdicts: softfail/temperror/none → not pass", () => {
  assert.deepEqual(extractAuthVerdicts("spf=softfail; dkim=temperror"), { spf: false, dkim: false });
  assert.deepEqual(extractAuthVerdicts("spf=none; dkim=none"), { spf: false, dkim: false });
});

test("extractAuthVerdicts: boundary — does not match 'passfail' as 'pass'", () => {
  // "spf=passfail" must NOT register as spf pass (token-boundary check).
  assert.deepEqual(extractAuthVerdicts("spf=passfail; dkim=passignored"), { spf: false, dkim: false });
});

test("extractAuthVerdicts: case-insensitive", () => {
  assert.deepEqual(extractAuthVerdicts("SPF=PASS; DKIM=Pass"), { spf: true, dkim: true });
});

// ─── pickRawHeadersSubset ───────────────────────────────────────────────────

test("pickRawHeadersSubset: returns present headers, trimmed; skips absent/empty", () => {
  const headers = new Map<string, string>([
    ["from", "  sender@example.com  "],
    ["subject", "Hello"],
    ["date", "Wed, 1 Jan 2026 00:00:00 +0000"],
    ["empty", "   "],
  ]);
  const out = pickRawHeadersSubset((n) => headers.get(n.toLowerCase()) ?? null);
  assert.equal(out.from, "sender@example.com");
  assert.equal(out.subject, "Hello");
  assert.equal(out.date, "Wed, 1 Jan 2026 00:00:00 +0000");
  assert.ok(!("empty" in out), "whitespace-only header omitted");
  assert.ok(!("authentication-results" in out), "absent header omitted");
});

test("pickRawHeadersSubset: includes authentication-results when present", () => {
  const out = pickRawHeadersSubset((n) =>
    n === "authentication-results" ? "mx.cf.net; spf=pass" : null,
  );
  assert.equal(out["authentication-results"], "mx.cf.net; spf=pass");
});

// ─── staleCutoffIso ─────────────────────────────────────────────────────────

test("staleCutoffIso: 30 days before the given instant", () => {
  // 2026-07-19T00:00:00Z minus 30 days → 2026-06-19T00:00:00Z
  const now = Date.UTC(2026, 6, 19); // month is 0-indexed (6 = July)
  const cutoff = staleCutoffIso(now, 30);
  assert.equal(cutoff, "2026-06-19T00:00:00.000Z");
});

test("staleCutoffIso: respects the days parameter", () => {
  const now = Date.UTC(2026, 6, 19);
  assert.equal(staleCutoffIso(now, 1), "2026-07-18T00:00:00.000Z");
  assert.equal(staleCutoffIso(now, 90), "2026-04-20T00:00:00.000Z");
});

test("staleCutoffIso: crosses month/year boundaries correctly", () => {
  // 2026-03-01 minus 30 days → 2026-01-30 (crosses Feb)
  const now = Date.UTC(2026, 2, 1); // March 1
  const cutoff = staleCutoffIso(now, 30);
  assert.equal(cutoff, "2026-01-30T00:00:00.000Z");
});

// ─── capBody ────────────────────────────────────────────────────────────────

test("capBody: null passes through, not truncated", () => {
  assert.deepEqual(capBody(null, 100), { value: null, truncated: false });
});

test("capBody: under ceiling → unchanged, not truncated", () => {
  assert.deepEqual(capBody("hello", 100), { value: "hello", truncated: false });
  assert.deepEqual(capBody("hello", 5), { value: "hello", truncated: false });
});

test("capBody: over ceiling → truncated true, value byte-bounded", () => {
  const { value, truncated } = capBody("hello world", 5);
  assert.equal(truncated, true);
  assert.equal(value, "hello");
});

test("capBody: byte cap splits a multibyte sequence into a replacement char, not a throw", () => {
  // "あ" is 3 UTF-8 bytes. Cap at 4 bytes: the first "あ" (3 bytes) survives
  // intact; the 4th byte is the leading byte of the second "あ", an incomplete
  // sequence the non-fatal decoder turns into U+FFFD. So the stored string is
  // the intact char + one replacement char — never a throw. (The stored value
  // can re-encode to maxBytes + ~2 at the boundary: a 1-byte partial becomes a
  // 3-byte replacement char. Immaterial for the cap's purpose.)
  const { value, truncated } = capBody("ああ", 4);
  assert.equal(truncated, true);
  assert.equal(typeof value, "string");
  assert.equal(value?.length, 2, "intact char + one replacement char");
  assert.equal(value?.[0], "あ", "first complete char preserved");
  assert.equal(
    value?.codePointAt(1),
    0xfffd,
    "the partial byte becomes U+FFFD, not a throw",
  );
});

test("capBody: exactly at ceiling → not truncated", () => {
  assert.deepEqual(capBody("hello", 5), { value: "hello", truncated: false });
});

// ─── extractLinks ───────────────────────────────────────────────────────────

test("extractLinks: single confirmation-style URL in text", () => {
  const text =
    "Confirm your forwarding address by visiting https://example.com/confirm?code=123 within 48h.";
  assert.deepEqual(extractLinks(text, null), ["https://example.com/confirm?code=123"]);
});

test("extractLinks: multiple links preserve first-seen order + dedupe", () => {
  const text =
    "See https://a.com/x and https://b.com/y then https://a.com/x again and https://c.com/z";
  assert.deepEqual(extractLinks(text, null), [
    "https://a.com/x",
    "https://b.com/y",
    "https://c.com/z",
  ]);
});

test("extractLinks: URL inside href=\"…\" in html is captured (no tag-stripping)", () => {
  // Tag-stripping would DELETE this URL (the <...> match spans the whole tag);
  // scanning raw html with the regex catches it. This is the regression guard.
  const html = `<p>Please <a href="https://accounts.google.com/confirm?c=ABC">confirm</a>.</p>`;
  assert.deepEqual(extractLinks(null, html), [
    "https://accounts.google.com/confirm?c=ABC",
  ]);
});

test("extractLinks: text + html merged; bare URL in html text node also caught", () => {
  const text = "Receipt at https://shop.example.com/r/9\n";
  const html = `<b>https://shop.example.com/r/9</b> <a href="https://help.example.com">help</a>`;
  assert.deepEqual(extractLinks(text, html), [
    "https://shop.example.com/r/9",
    "https://help.example.com",
  ]);
});

test("extractLinks: trailing punctuation is trimmed", () => {
  const text = "Visit https://example.com. Then https://other.com/path), done.";
  assert.deepEqual(extractLinks(text, null), ["https://example.com", "https://other.com/path"]);
});

test("extractLinks: no URLs → empty array (no throw)", () => {
  assert.deepEqual(extractLinks("Just prose, no links here.", null), []);
  assert.deepEqual(extractLinks(null, null), []);
  assert.deepEqual(extractLinks("", ""), []);
});

test("extractLinks: caps at maxLinks (default 20), still deduped", () => {
  const text = Array.from({ length: 30 }, (_, i) => `https://x.com/${i}`).join(" ");
  const links = extractLinks(text, null);
  assert.equal(links.length, 20);
  assert.equal(new Set(links).size, 20, "no dupes within the capped set");
  assert.equal(links[0], "https://x.com/0");
});

test("extractLinks: explicit maxLinks override", () => {
  const text = "https://a.com https://b.com https://c.com https://d.com";
  assert.equal(extractLinks(text, null, 2).length, 2);
});

// ─── parseTrustedIntakeSenders ──────────────────────────────────────────────

test("parseTrustedIntakeSenders: comma-separated, trimmed, lowercased, empties dropped", () => {
  assert.deepEqual(
    parseTrustedIntakeSenders("David@Gmail.com, foo@bar.com ,, bar@bar.com"),
    ["david@gmail.com", "foo@bar.com", "bar@bar.com"],
  );
});

test("parseTrustedIntakeSenders: null/undefined/blank → []", () => {
  assert.deepEqual(parseTrustedIntakeSenders(null), []);
  assert.deepEqual(parseTrustedIntakeSenders(undefined), []);
  assert.deepEqual(parseTrustedIntakeSenders(""), []);
  assert.deepEqual(parseTrustedIntakeSenders("   "), []);
});

// ─── isAutoPromoteEligible (ADR 0011 Phase B auto-promote gate) ─────────────
// The compensating control for receipts@ being a public, unauthenticated
// address: only an allowlisted sender with passing SPF AND DKIM and NO valid
// attachment gets auto-promoted with no operator click.

test("isAutoPromoteEligible: allowlisted + SPF+DKIM + body-only → true", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com", "other@x.com"],
    }),
    true,
  );
});

test("isAutoPromoteEligible: non-allowlisted sender → false even with SPF+DKIM", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "stranger@evil.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
    }),
    false,
  );
});

test("isAutoPromoteEligible: SPF or DKIM fail → false even if allowlisted", () => {
  const base = {
    fromAddress: "david@gmail.com",
    hasValidAttachment: false,
    trustedSenders: ["david@gmail.com"],
  } as const;
  assert.equal(isAutoPromoteEligible({ ...base, spfPass: false, dkimPass: true }), false);
  assert.equal(isAutoPromoteEligible({ ...base, spfPass: true, dkimPass: false }), false);
});

test("isAutoPromoteEligible: a valid attachment → false (attachments stay manual-triage)", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: true,
      trustedSenders: ["david@gmail.com"],
    }),
    false,
  );
});

test("isAutoPromoteEligible: from_address matched case-insensitively", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "DAVID@Gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
    }),
    true,
  );
});

// ─── isAutoPromoteEligible: ADR 0011 follow-up — prospective trust + blocked ─

test("isAutoPromoteEligible: blocked sender → false even if also trusted + SPF + DKIM", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
      blockedSenders: ["david@gmail.com"],
    }),
    false,
  );
});

test("isAutoPromoteEligible: prospective — older intake → false", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
      receivedAt: "2026-06-01T00:00:00.000Z",
      trustedCreatedAt: "2026-07-01T00:00:00.000Z",
    }),
    false,
  );
});

test("isAutoPromoteEligible: prospective — equal timestamp → true", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
      receivedAt: "2026-07-01T00:00:00.000Z",
      trustedCreatedAt: "2026-07-01T00:00:00.000Z",
    }),
    true,
  );
});

test("isAutoPromoteEligible: prospective — newer intake → true", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
      receivedAt: "2026-08-01T00:00:00.000Z",
      trustedCreatedAt: "2026-07-01T00:00:00.000Z",
    }),
    true,
  );
});

test("isAutoPromoteEligible: malformed received_at → false", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
      receivedAt: "not-a-date",
      trustedCreatedAt: "2026-07-01T00:00:00.000Z",
    }),
    false,
  );
});

test("isAutoPromoteEligible: malformed trusted_created_at → false", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
      receivedAt: "2026-08-01T00:00:00.000Z",
      trustedCreatedAt: "garbage",
    }),
    false,
  );
});

test("isAutoPromoteEligible: no trustedCreatedAt → true (backward compat)", () => {
  assert.equal(
    isAutoPromoteEligible({
      fromAddress: "david@gmail.com",
      spfPass: true,
      dkimPass: true,
      hasValidAttachment: false,
      trustedSenders: ["david@gmail.com"],
      receivedAt: "2026-01-01T00:00:00.000Z",
    }),
    true,
  );
});
