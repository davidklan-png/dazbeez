import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_RECEIPT_EXTENSIONS,
  ALLOWED_RECEIPT_MIME_TYPES,
  DESKTOP_MAX_CONCURRENT_UPLOADS,
  MAX_DESKTOP_BATCH_FILES,
  MAX_RECEIPT_FILE_BYTES,
  RECEIPT_ACCEPT_ATTR,
  VALID_SOURCES,
  VALID_SOURCE_TYPES,
  deriveSourceType,
  formatFileSize,
  isValidSource,
  validateReceiptFile,
} from "@/lib/receipts/upload-policy";

function makeFile(name: string, type: string, sizeBytes: number): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type });
}

// ─── Provenance: VALID_SOURCES / isValidSource ──────────────────────────────

test("VALID_SOURCES: exactly the two capture provenances", () => {
  assert.deepEqual([...VALID_SOURCES], ["mobile_capture", "desktop_upload"]);
});

test("isValidSource: accepts the two known sources, rejects everything else", () => {
  assert.equal(isValidSource("mobile_capture"), true);
  assert.equal(isValidSource("desktop_upload"), true);
  // The old DB default / stale values must NOT be accepted as a `source`.
  assert.equal(isValidSource("upload"), false);
  assert.equal(isValidSource("manual_upload"), false); // a source_type, not a source
  assert.equal(isValidSource("web"), false);
  assert.equal(isValidSource(""), false);
  assert.equal(isValidSource(undefined), false);
});

// ─── Classification: deriveSourceType ───────────────────────────────────────

test("deriveSourceType: explicit valid sourceType wins over heuristic", () => {
  assert.equal(
    deriveSourceType("digital_invoice", "desktop_upload", "application/pdf"),
    "digital_invoice",
  );
  assert.equal(
    deriveSourceType("email_attachment", "mobile_capture", "image/jpeg"),
    "email_attachment",
  );
});

test("deriveSourceType: an explicit but invalid sourceType is ignored", () => {
  assert.equal(
    deriveSourceType("nonsense", "desktop_upload", "application/pdf"),
    "electronic_receipt",
  );
});

test("deriveSourceType: mobile_capture → paper_scanned, even for a PDF", () => {
  // Camera capture is paper-scanned regardless of content type; mobile beats
  // the PDF rule (architect rule order).
  assert.equal(
    deriveSourceType(undefined, "mobile_capture", "application/pdf"),
    "paper_scanned",
  );
  assert.equal(
    deriveSourceType(undefined, "mobile_capture", "image/jpeg"),
    "paper_scanned",
  );
});

test("deriveSourceType: desktop PDF → electronic_receipt", () => {
  assert.equal(
    deriveSourceType(undefined, "desktop_upload", "application/pdf"),
    "electronic_receipt",
  );
});

test("deriveSourceType: desktop image → manual_upload (no paper-scan guessing)", () => {
  // The classifier never sees the filename — and even for a paper-looking
  // image, desktop origin stays manual_upload. The system lacks the
  // information to infer "paper scan" reliably (architect decision).
  assert.equal(
    deriveSourceType(undefined, "desktop_upload", "image/png"),
    "manual_upload",
  );
  assert.equal(
    deriveSourceType(undefined, "desktop_upload", "image/jpeg"),
    "manual_upload",
  );
  assert.equal(
    deriveSourceType(undefined, "desktop_upload", "application/octet-stream"),
    "manual_upload",
  );
});

test("VALID_SOURCE_TYPES: covers the union used by both upload routes", () => {
  assert.ok(VALID_SOURCE_TYPES.includes("paper_scanned"));
  assert.ok(VALID_SOURCE_TYPES.includes("electronic_receipt"));
  assert.ok(VALID_SOURCE_TYPES.includes("manual_upload"));
  assert.ok(VALID_SOURCE_TYPES.includes("amex_csv"));
});

// ─── validateReceiptFile: the no-EML/HTML policy ────────────────────────────

test("validateReceiptFile: accepted types pass", () => {
  for (const mime of ALLOWED_RECEIPT_MIME_TYPES) {
    const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1] ?? "jpg";
    const file = makeFile(`receipt.${ext}`, mime, 1024);
    assert.equal(validateReceiptFile(file), null, `expected null for ${mime}`);
  }
});

test("validateReceiptFile: EML and HTML are rejected (no ingestion pipeline)", () => {
  const eml = makeFile("receipt.eml", "message/rfc822", 1024);
  assert.ok(validateReceiptFile(eml), "EML must be rejected");
  const html = makeFile("receipt.html", "text/html", 1024);
  assert.ok(validateReceiptFile(html), "HTML must be rejected");
});

test("validateReceiptFile: oversize rejected, boundary passes", () => {
  assert.ok(validateReceiptFile(makeFile("big.jpg", "image/jpeg", MAX_RECEIPT_FILE_BYTES + 1)));
  assert.equal(
    validateReceiptFile(makeFile("max.jpg", "image/jpeg", MAX_RECEIPT_FILE_BYTES)),
    null,
  );
});

// ─── Limits & formatting (lock the contract used in UI copy) ───────────────

test("limits: desktop batch = 25, concurrency = 3, size = 5 MiB", () => {
  assert.equal(MAX_DESKTOP_BATCH_FILES, 25);
  assert.equal(DESKTOP_MAX_CONCURRENT_UPLOADS, 3);
  assert.equal(MAX_RECEIPT_FILE_BYTES, 5 * 1024 * 1024);
});

test("RECEIPT_ACCEPT_ATTR: advertises images + PDF only, never EML/HTML", () => {
  assert.match(RECEIPT_ACCEPT_ATTR, /image\/\*/);
  assert.match(RECEIPT_ACCEPT_ATTR, /application\/pdf/);
  assert.doesNotMatch(RECEIPT_ACCEPT_ATTR, /eml|html/i);
});

test("ALLOWED_RECEIPT_EXTENSIONS: no eml/html entries", () => {
  assert.ok(!ALLOWED_RECEIPT_EXTENSIONS.includes(".eml"));
  assert.ok(!ALLOWED_RECEIPT_EXTENSIONS.includes(".html"));
});

test("formatFileSize: renders the byte counts used in copy", () => {
  assert.equal(formatFileSize(MAX_RECEIPT_FILE_BYTES), "5 MB");
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(2048), "2.0 KB");
});
