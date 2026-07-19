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
