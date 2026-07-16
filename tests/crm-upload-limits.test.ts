import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_BUSINESS_CARD_EXTENSIONS,
  ALLOWED_BUSINESS_CARD_MIME_TYPES,
  formatFileSize,
  getBusinessCardFileTypeError,
  getImageSizeValidationError,
  MAX_BATCH_AI_IMAGE_BYTES,
} from "@/lib/crm-upload-limits";

function makeFile(name: string, type: string, sizeBytes: number): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type });
}

test("formatFileSize renders human-readable values", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(1536), "1.5 KB");
  assert.equal(formatFileSize(2.5 * 1024 * 1024), "2.5 MB");
});

test("getImageSizeValidationError rejects oversized uploads and accepts smaller ones", () => {
  assert.equal(
    getImageSizeValidationError({
      fileSize: MAX_BATCH_AI_IMAGE_BYTES,
      label: "The composite image",
    }),
    null,
  );

  assert.match(
    getImageSizeValidationError({
      fileSize: MAX_BATCH_AI_IMAGE_BYTES + 1,
      label: "The composite image",
    }) ?? "",
    /Maximum allowed size is 4\.0 MB/,
  );
});

// ─── Business-card MIME policy ─────────────────────────────────────────────

test("ALLOWED_BUSINESS_CARD_*: image-only, no pdf/html", () => {
  assert.ok(!ALLOWED_BUSINESS_CARD_MIME_TYPES.includes("application/pdf"));
  assert.ok(!ALLOWED_BUSINESS_CARD_EXTENSIONS.includes(".pdf"));
  assert.ok(!ALLOWED_BUSINESS_CARD_EXTENSIONS.includes(".html"));
});

test("getBusinessCardFileTypeError: accepted image types pass", () => {
  for (const mime of ALLOWED_BUSINESS_CARD_MIME_TYPES) {
    const ext = mime === "image/jpeg" ? "jpg" : (mime.split("/")[1] ?? "jpg");
    const file = makeFile(`card.${ext}`, mime, 1024);
    assert.equal(
      getBusinessCardFileTypeError(file),
      null,
      `expected null for ${mime}`,
    );
  }
});

test("getBusinessCardFileTypeError: non-image and spoofed types are rejected", () => {
  // Specific non-allowlisted MIMEs are rejected outright.
  assert.ok(
    getBusinessCardFileTypeError(makeFile("card.pdf", "application/pdf", 1024)),
  );
  assert.ok(
    getBusinessCardFileTypeError(makeFile("anim.gif", "image/gif", 1024)),
  );
  // text/html named *.jpg: MIME is specific and not allowlisted; the .jpg
  // extension must not rescue it.
  assert.ok(
    getBusinessCardFileTypeError(makeFile("card.jpg", "text/html", 1024)),
  );
});

test("getBusinessCardFileTypeError: extension fallback for empty/generic MIME", () => {
  assert.equal(getBusinessCardFileTypeError(makeFile("card.jpg", "", 1024)), null);
  assert.equal(
    getBusinessCardFileTypeError(
      makeFile("card.png", "application/octet-stream", 1024),
    ),
    null,
  );
  assert.ok(
    getBusinessCardFileTypeError(
      makeFile("card.exe", "application/octet-stream", 1024),
    ),
  );
});
