import test from "node:test";
import assert from "node:assert/strict";
import {
  formatFileSize,
  getImageSizeValidationError,
  MAX_BATCH_AI_IMAGE_BYTES,
} from "@/lib/crm-upload-limits";

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
