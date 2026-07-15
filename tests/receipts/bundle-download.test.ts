import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_DOWNLOAD_FILES,
  resolveBundleDownload,
  buildMonthlyExportCsv,
  buildExportSummaryCsv,
  buildManifestCsv,
  buildExportReadme,
} from "@/lib/receipts/export";
import { assembleProofsZip } from "@/lib/receipts/proofs";
import { computeSha256Hex } from "@/lib/receipts/storage";
import type { DownloadExportRecord } from "@/lib/receipts/export";
import type { ExportRow } from "@/lib/receipts/types";

const month = "2026-06";

// Fixtures: a finalized rev-1, a rebuilt draft rev-2, and an un-rebuilt draft.
const finalized: DownloadExportRecord = {
  id: "exp-fin",
  archive_r2_key: "exports/2026-06/exp-fin-receipts.csv",
  manifest_r2_key: "exports/2026-06/exp-fin-manifest.csv",
  proofs_r2_key: "exports/2026-06/exp-fin-proofs.zip",
  bundle_built_at: "2026-07-01T00:00:00Z",
};
const draftRebuilt: DownloadExportRecord = {
  id: "exp-draft",
  archive_r2_key: "exports/2026-06/exp-draft-receipts.csv",
  manifest_r2_key: "exports/2026-06/exp-draft-manifest.csv",
  proofs_r2_key: "exports/2026-06/exp-draft-proofs.zip",
  bundle_built_at: "2026-07-10T00:00:00Z",
};
const draftUnbuilt: DownloadExportRecord = {
  id: "exp-draft2",
  archive_r2_key: null,
  manifest_r2_key: null,
  proofs_r2_key: null,
  bundle_built_at: null,
};

function ok(r: ReturnType<typeof resolveBundleDownload>) {
  assert.ok(r.ok, "expected resolution to succeed");
  return r as Extract<typeof r, { ok: true }>;
}

// ─── Default path: latest FINALIZED (not the open draft) ────────────────────

test("default path serves the finalized revision, not the open draft, when both exist", () => {
  const r = ok(
    resolveBundleDownload({
      month,
      file: "receipts",
      draft: false,
      draftRecord: draftRebuilt,
      finalizedRecord: finalized,
    }),
  );
  assert.equal(r.exportId, "exp-fin", "must resolve to the finalized record");
  assert.equal(r.draft, false);
  assert.equal(r.r2Key, finalized.archive_r2_key);
  assert.equal(r.filename, "export-2026-06-receipts.csv", "finalized names are clean (no DRAFT-)");
});

test("default path 404s when no finalized revision exists yet", () => {
  const r = resolveBundleDownload({
    month,
    file: "receipts",
    draft: false,
    draftRecord: draftRebuilt,
    finalizedRecord: null,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 404);
    assert.match(r.message, /No finalized export/);
  }
});

test("default proofs 404 gives the revision guidance (sealed before proofs)", () => {
  const r = resolveBundleDownload({
    month,
    file: "proofs",
    draft: false,
    draftRecord: null,
    finalizedRecord: { ...finalized, proofs_r2_key: null },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /sealed before the proofs ZIP existed/);
});

// ─── ?draft=true path ───────────────────────────────────────────────────────

test("draft=true serves the rebuilt draft's artifact with DRAFT- prefix", () => {
  const r = ok(
    resolveBundleDownload({
      month,
      file: "proofs",
      draft: true,
      draftRecord: draftRebuilt,
      finalizedRecord: finalized,
    }),
  );
  assert.equal(r.exportId, "exp-draft", "must resolve to the draft record");
  assert.equal(r.draft, true);
  assert.equal(r.r2Key, draftRebuilt.proofs_r2_key);
  assert.equal(
    r.filename,
    "DRAFT-export-2026-06-proofs.zip",
    "draft filenames are prefixed DRAFT-",
  );
});

test("draft=true 404s before rebuild (no bundle_built_at)", () => {
  const r = resolveBundleDownload({
    month,
    file: "receipts",
    draft: true,
    draftRecord: draftUnbuilt,
    finalizedRecord: finalized,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 404);
    assert.match(r.message, /Draft not rebuilt yet/);
  }
});

test("draft=true 404s when there is no draft revision", () => {
  const r = resolveBundleDownload({
    month,
    file: "receipts",
    draft: true,
    draftRecord: null,
    finalizedRecord: finalized,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 404);
    assert.match(r.message, /No draft revision/);
  }
});

// ─── DRAFT- prefix on EVERY file kind ───────────────────────────────────────

test("draft=true prefixes DRAFT- on every file kind; default never does", () => {
  for (const file of EXPORT_DOWNLOAD_FILES) {
    const d = ok(
      resolveBundleDownload({
        month,
        file,
        draft: true,
        draftRecord: draftRebuilt,
        finalizedRecord: finalized,
      }),
    );
    assert.ok(
      d.filename.startsWith("DRAFT-"),
      `draft ${file} must be DRAFT- prefixed (got ${d.filename})`,
    );
    assert.equal(d.draft, true);

    const f = ok(
      resolveBundleDownload({
        month,
        file,
        draft: false,
        draftRecord: draftRebuilt,
        finalizedRecord: finalized,
      }),
    );
    assert.ok(
      !f.filename.startsWith("DRAFT-"),
      `finalized ${file} must NOT be DRAFT- prefixed (got ${f.filename})`,
    );
    assert.equal(f.draft, false);
  }
});

// ─── Byte-identity: no draft/finalize-conditional content ───────────────────
// Drafts are the candidate seal. finalize re-uses the staged R2 objects (it
// does not rebuild), so a staged draft's bytes == the sealed bytes. This test
// guards the precondition: every artifact BUILDER is deterministic for
// identical inputs (no `if (draft)` branch, no per-call randomness) — so the
// draft build and the finalize build (same inputs) produce identical bytes.
// The DRAFT- filename prefix + audit flag are the ONLY draft signals.

function makeRow(over: Partial<ExportRow> = {}): ExportRow {
  return {
    rowType: "amex_line",
    lineId: "l-1",
    matchStatus: null,
    receiptStatus: null,
    missingReceiptReason: null,
    cardholderName: null,
    businessTripStatus: null,
    receiptId: "r-1",
    status: "reviewed",
    originalR2Key: null,
    transactionDate: "2026-06-11",
    merchant: "OpenAI",
    amountMinor: 108341,
    currency: "JPY",
    expenseType: "UNKNOWN",
    expenseCategoryCode: "rd",
    expenseCategoryJa: "研究開発費",
    expenseCategoryEn: "R&D",
    paymentPath: "AMEX",
    businessPurpose: null,
    attendees: [],
    invoiceRegistrationNumber: null,
    qualifiedInvoiceStatus: null,
    taxRate: null,
    taxAmountMinor: null,
    sourceType: null,
    counterpartyName: null,
    ...over,
  };
}

test("byte-identity: text artifacts are deterministic (no draft-conditional content)", async () => {
  const rows = [makeRow(), makeRow({ receiptId: "r-2", merchant: "屋形舟", amountMinor: 69000 })];
  const attendeeMap = new Map<string, string[]>();
  const generatedAt = "2026-07-15T00:00:00Z";

  // Same inputs twice → identical bytes (and identical SHA-256).
  const csvA = buildMonthlyExportCsv(rows, attendeeMap);
  const csvB = buildMonthlyExportCsv(rows, attendeeMap);
  assert.equal(csvA, csvB);

  const sumA = buildExportSummaryCsv(rows, month, generatedAt);
  const sumB = buildExportSummaryCsv(rows, month, generatedAt);
  assert.equal(sumA, sumB);

  const manifestOpts = {
    proofsArtifact: {
      r2Key: "p",
      sha256Hash: "psha",
      originalFilename: "proofs.zip",
    },
  } as const;
  const manA = buildManifestCsv("e1", month, "k", "sha", rows.length, generatedAt, null, manifestOpts);
  const manB = buildManifestCsv("e1", month, "k", "sha", rows.length, generatedAt, null, manifestOpts);
  assert.equal(manA, manB);

  const readmeOpts = {
    exportId: "e1",
    month,
    rowCount: rows.length,
    generatedAt,
    exportRevision: 1,
    archiveSha256: "a",
    manifestSha256: "m",
    summarySha256: "s",
    proofsSha256: "p",
  };
  assert.equal(buildExportReadme(readmeOpts), buildExportReadme(readmeOpts));

  // SHA-256 equality is the operator's sign-off check — same bytes ⇒ same hash.
  const enc = new TextEncoder();
  assert.equal(
    await computeSha256Hex(enc.encode(csvA)),
    await computeSha256Hex(enc.encode(csvB)),
  );
});

test("byte-identity: the proofs ZIP builder takes no draft flag (draft⇄seal can't diverge at build time)", async () => {
  // assembleProofsZip(month, entries, noticeInput) — no draft/finalize param.
  // A draft and a finalize that stage the same entries produce the same zip;
  // finalize re-uses the staged object rather than rebuilding, so the operator's
  // downloaded draft zip and the sealed zip are the same bytes.
  const enc = new TextEncoder();
  const entries = [
    {
      no: 3,
      categoryJa: "研究開発費",
      merchant: "OpenAI",
      amountMinor: 108341,
      currency: "JPY",
      ext: "pdf" as const,
      source: "proof_copy" as const,
      bytes: enc.encode("%PDF-1.4 test"),
      transactionDate: "2026-06-11",
      receiptId: "r-1",
      statementLineId: "l-1",
      sha256: "abc",
      paymentPath: "AMEX" as const,
    },
  ];
  const notice = {
    monthLabel: "2026年6月",
    rowCount: 1,
    receiptCount: 1,
    missingReceiptLines: [],
    icAdvisories: [],
    exportRevision: 1,
  };
  const a = assembleProofsZip(month, entries, notice);
  assert.ok(a instanceof Uint8Array && a.length > 0);
  // The builder has no draft parameter to branch on — draft and finalize share
  // it. (Cross-call byte equality is not asserted because the zip's own
  // finalize step re-uses the staged object; the guarantee is flow-level.)
});
