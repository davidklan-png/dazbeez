import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_DOWNLOAD_FILES,
  isExportDownloadFile,
  resolveExportDownload,
  buildSummaryKey,
  buildReadmeKey,
} from "@/lib/receipts/export";

// Pure decision logic behind GET /api/receipts/export/[month]/download:
// which R2 key, Content-Type, and attachment filename each `file` value
// resolves to. The route itself (auth, 409-on-draft, R2 fetch) runs against
// live bindings and is exercised via cf:dev, not mocked here.

const month = "2026-06";
const exportRecord = {
  id: "exp-123",
  archive_r2_key: "exports/2026-06/exp-123-receipts.csv",
  manifest_r2_key: "exports/2026-06/exp-123-manifest.csv",
};

test("isExportDownloadFile accepts exactly the four bundle files", () => {
  for (const file of EXPORT_DOWNLOAD_FILES) {
    assert.equal(isExportDownloadFile(file), true);
  }
  assert.equal(isExportDownloadFile(""), false);
  assert.equal(isExportDownloadFile("zip"), false);
  assert.equal(isExportDownloadFile("Receipts"), false);
  assert.equal(isExportDownloadFile("readme.txt"), false);
});

test("receipts resolves to the STORED archive key, untransformed", () => {
  const target = resolveExportDownload(month, exportRecord, "receipts");
  assert.equal(target.r2Key, exportRecord.archive_r2_key);
  assert.equal(target.contentType, "text/csv; charset=utf-8");
  assert.equal(target.filename, "export-2026-06-receipts.csv");
});

test("manifest resolves to the STORED manifest key", () => {
  const target = resolveExportDownload(month, exportRecord, "manifest");
  assert.equal(target.r2Key, exportRecord.manifest_r2_key);
  assert.equal(target.contentType, "text/csv; charset=utf-8");
  assert.equal(target.filename, "export-2026-06-manifest.csv");
});

test("summary derives its key via buildSummaryKey", () => {
  const target = resolveExportDownload(month, exportRecord, "summary");
  assert.equal(target.r2Key, buildSummaryKey(month, exportRecord.id));
  assert.equal(target.r2Key, "exports/2026-06/exp-123-summary.csv");
  assert.equal(target.contentType, "text/csv; charset=utf-8");
  assert.equal(target.filename, "export-2026-06-summary.csv");
});

test("readme derives its key via buildReadmeKey and ships as text/plain .txt", () => {
  const target = resolveExportDownload(month, exportRecord, "readme");
  assert.equal(target.r2Key, buildReadmeKey(month, exportRecord.id));
  assert.equal(target.r2Key, "exports/2026-06/exp-123-README.txt");
  assert.equal(target.contentType, "text/plain; charset=utf-8");
  assert.equal(target.filename, "export-2026-06-readme.txt");
});

test("stored-key files surface a null key (route 404s) when the record lacks them", () => {
  const bare = { id: "exp-123", archive_r2_key: null, manifest_r2_key: null };
  assert.equal(resolveExportDownload(month, bare, "receipts").r2Key, null);
  assert.equal(resolveExportDownload(month, bare, "manifest").r2Key, null);
  // Derived keys never depend on the stored columns.
  assert.ok(resolveExportDownload(month, bare, "summary").r2Key);
  assert.ok(resolveExportDownload(month, bare, "readme").r2Key);
});

test("proofs resolves to the stored proofs zip key as application/zip", () => {
  const withProofs = {
    ...exportRecord,
    proofs_r2_key: "exports/2026-06/exp-123-proofs.zip",
  };
  const target = resolveExportDownload(month, withProofs, "proofs");
  assert.equal(target.r2Key, "exports/2026-06/exp-123-proofs.zip");
  assert.equal(target.contentType, "application/zip");
  assert.equal(target.filename, "202606_Dazbeez_Monthly_Expense_Report.zip");
});

test("proofs surfaces a null key (route 404s) when the record predates the artifact", () => {
  // A row sealed before PR 2 (no proofs_r2_key) — proofs download 404s.
  assert.equal(resolveExportDownload(month, exportRecord, "proofs").r2Key, null);
  const bare = { id: "exp-123", archive_r2_key: null, manifest_r2_key: null };
  assert.equal(resolveExportDownload(month, bare, "proofs").r2Key, null);
});
