import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManifestCsv,
  buildExportReadme,
} from "@/lib/receipts/export";
import type { ReceiptFile } from "@/lib/receipts/types";

function makeFile(overrides: Partial<ReceiptFile> = {}): ReceiptFile {
  return {
    id: "f1",
    object_type: "receipt",
    object_id: "rec_1",
    role: "original",
    r2_bucket: "receipts",
    r2_key: "receipts/2026/05/rec_1/scan.jpg",
    original_filename: "scan.jpg",
    content_type: "image/jpeg",
    file_size_bytes: 1024,
    sha256_hash: "deadbeef",
    uploaded_by: "test",
    uploaded_at: "2026-05-01T00:00:00Z",
    is_original: 1,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

test("manifest: baseline fields are always present", () => {
  const csv = buildManifestCsv(
    "exp_1",
    "2026-05",
    "exports/2026-05/exp_1-receipts.csv",
    "hashabc",
    3,
    "2026-05-19T12:00:00Z",
  );
  assert.match(csv, /^Field,Value/);
  assert.match(csv, /ExportId,exp_1/);
  assert.match(csv, /Month,2026-05/);
  assert.match(csv, /SHA256,hashabc/);
  assert.match(csv, /RowCount,3/);
});

test("manifest: revision fields appear when supplied", () => {
  const csv = buildManifestCsv(
    "exp_2",
    "2026-05",
    "key",
    "hash",
    1,
    "2026-05-19T12:00:00Z",
    null,
    {
      exportRevision: 2,
      supersedesExportId: "exp_1",
      correctionReason: "Reissued after late receipt",
    },
  );
  assert.match(csv, /ExportRevision,2/);
  assert.match(csv, /SupersedesExportId,exp_1/);
  assert.match(csv, /CorrectionReason,Reissued after late receipt/);
});

test("manifest: file table includes one row per file with hash", () => {
  const csv = buildManifestCsv(
    "exp_1",
    "2026-05",
    "key",
    "hash",
    2,
    "2026-05-19T12:00:00Z",
    null,
    {
      files: [
        makeFile({ id: "f1", sha256_hash: "aaa" }),
        makeFile({
          id: "f2",
          object_id: "rec_2",
          r2_key: "k2",
          sha256_hash: "bbb",
        }),
      ],
    },
  );
  assert.match(csv, /ObjectType,ObjectId,Role/);
  assert.match(csv, /,aaa,/);
  assert.match(csv, /,bbb,/);
});

test("manifest: amex artifact triple is emitted", () => {
  const csv = buildManifestCsv(
    "exp_1",
    "2026-05",
    "key",
    "hash",
    1,
    "2026-05-19T12:00:00Z",
    null,
    {
      amexArtifact: {
        r2Key: "amex/2026-05/abc",
        sha256Hash: "zzz",
        originalFilename: "netanswer.csv",
      },
    },
  );
  assert.match(csv, /AmexArtifactKey,amex\/2026-05\/abc/);
  assert.match(csv, /AmexArtifactSha256,zzz/);
  assert.match(csv, /AmexArtifactFilename,netanswer\.csv/);
});

test("readme: contains accountant-review disclaimer", () => {
  const readme = buildExportReadme({
    exportId: "exp_1",
    month: "2026-05",
    rowCount: 5,
    generatedAt: "2026-05-19T12:00:00Z",
    exportRevision: 1,
    archiveSha256: "hash",
    manifestSha256: "mhash",
  });
  assert.match(readme, /accountant review/i);
  assert.match(readme, /税理士/);
  assert.match(readme, /SHA-256.*hash/);
  assert.match(readme, /Revision: 1/);
});

test("readme: revision > 1 shows correction reason", () => {
  const readme = buildExportReadme({
    exportId: "exp_2",
    month: "2026-05",
    rowCount: 5,
    generatedAt: "2026-05-19T12:00:00Z",
    exportRevision: 2,
    supersedesExportId: "exp_1",
    correctionReason: "Receipt added late",
    archiveSha256: "hash",
    manifestSha256: "mhash",
  });
  assert.match(readme, /Revision: 2/);
  assert.match(readme, /supersedes exp_1/);
  assert.match(readme, /Receipt added late/);
});
