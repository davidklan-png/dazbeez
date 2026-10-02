import test from "node:test";
import assert from "node:assert/strict";
import {
  contentDispositionAttachment,
  contentDispositionInline,
} from "@/lib/receipts/export";

// ─── contentDispositionInline (view-raw-AMEX-CSV affordance, TASK-033) ──────
// Same ByteString/RFC 5987 rules the attachment variant's tests pin in
// bundle-download.test.ts — ASCII stays plain, non-ASCII gets an ASCII
// fallback + filename*=UTF-8''…, and only the disposition type differs.

test("contentDispositionInline: ASCII stays plain inline", () => {
  assert.equal(
    contentDispositionInline("x.csv"),
    `inline; filename="x.csv"`,
  );
});

test("contentDispositionInline: non-ASCII gets ASCII fallback + RFC 5987 filename*", () => {
  const cd = contentDispositionInline("明細.csv");
  assert.ok(cd.startsWith(`inline; filename="`), "inline disposition with an ASCII filename");
  assert.ok(cd.includes("filename*=UTF-8''"), "RFC 5987 filename* present");
  const encoded = cd.slice(cd.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length);
  assert.equal(decodeURIComponent(encoded), "明細.csv", "filename* decodes back to the original");
  assert.ok(/^[\x00-\xFF]*$/.test(cd), "header value is Latin-1 (ByteString) safe");
});

test("contentDispositionInline matches contentDispositionAttachment except for the type", () => {
  const name = "202606_現金払いリスト.csv";
  assert.equal(
    contentDispositionInline(name).replace(/^inline/, "attachment"),
    contentDispositionAttachment(name),
  );
  assert.equal(
    contentDispositionInline("plain.csv").replace(/^inline/, "attachment"),
    contentDispositionAttachment("plain.csv"),
  );
});
