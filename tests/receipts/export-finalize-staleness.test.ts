import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMonthlyExportCsv, hashCsvContent } from "@/lib/receipts/export";
import type { ExportRow } from "@/lib/receipts/types";

// export-finalize-staleness — Part C of the one-shot finalize work.
//
// The staleness gap (one-shot prompt §"Why" defect 2): the OLD seal-only path
// (`/api/receipts/export/[month]`) validates a FRESH `buildExportBundle(month)`
// against the gate, then seals the LAST-STAGED `archive_r2_key`/`manifest_r2_key`/
// `archive_sha256` read back from the `receipt_exports` row. If anything changed
// between the last Rebuild and Finalize, the gate approves one bundle and the
// seal ships another — nothing detects it.
//
// The one-shot path (`POST /api/receipts/export/month` with `finalize: true`) was
// built to close that gap: it builds → stages → gates → seals the SAME bundle in
// one request, passing the freshly-computed keys/hashes as IN-MEMORY args to
// finalizeExport (which takes them as required params since the Phase B P1 fix).
// These tests pin that property so it cannot silently regress to the read-back-
// from-row pattern. No behaviour change — assertion + regression only.

const ROUTE_PATH = "app/api/receipts/export/month/route.ts";

/** Strip // line comments and /* block comments so a comment can't masquerade
 *  as code (the same hole that once let a bug hide behind a stale doc comment). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

/** Extract the argument text of the first `fnName(...)` call, paren-balanced. */
function extractCallArgs(src: string, fnName: string): string {
  const callStart = src.indexOf(`${fnName}(`);
  assert.ok(callStart > -1, `${fnName}( not found in ${ROUTE_PATH}`);
  const openParen = src.indexOf("(", callStart);
  let depth = 1;
  let i = openParen + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    i++;
  }
  assert.equal(depth, 0, `${fnName}( is unbalanced in ${ROUTE_PATH}`);
  return src.slice(openParen + 1, i - 1);
}

// ─── Structural: the one-shot path seals what it just built, not a prior row ──

test("export-finalize-staleness: one-shot finalizeExport is passed in-memory keys/hashes, never values read back from the export row", () => {
  // The load-bearing staleness guard. If the route ever regresses to reading
  // archive_r2_key / manifest_r2_key / archive_sha256 (etc.) off `exportRecord`
  // — the row fetched by getExport(month) — and passing THOSE to finalizeExport,
  // the seal could again ship a bundle the gate never validated. The one-shot
  // path must pass the freshly-built locals; finalizeExport's own params are
  // required (Phase B P1), so a re-introduced row read would show up here as
  // `exportRecord` inside the call.
  const raw = readFileSync(ROUTE_PATH, "utf8");
  const src = stripComments(raw);

  // getExport(month) is the only export-row read on the path; it must exist
  // (revision metadata + stored operator_message), and it must NOT feed sealed
  // bundle identity into finalizeExport.
  assert.ok(/getExport\(month\)/.test(src), "the one-shot path reads revision metadata via getExport(month)");

  const args = stripComments(extractCallArgs(src, "finalizeExport"));
  assert.ok(
    !/exportRecord/.test(args),
    "finalizeExport must seal in-memory values computed this request — never values read back from the export row (that is the staleness gap)",
  );
  // Positive anchor: the freshly-built locals are what get sealed.
  assert.ok(
    /archiveKey/.test(args) && /sha256/.test(args),
    "finalizeExport seals the freshly-built archiveKey + archive sha256 locals",
  );
});

test("export-finalize-staleness: the export-row read (getExport) supplies only revision metadata + stored message, consumed before any key/hash is computed", () => {
  // Defense for the assertion above: document WHY exportRecord is safe to fetch
  // — it is read for export_revision / supersedes_export_id / correction_reason
  // / operator_message, all consumed before archiveKey/sha256 are computed, and
  // none of them are sealed bundle identity. If a sealed field (archive_r2_key,
  // manifest_r2_key, archive_sha256, manifest_sha256, proofs_r2_key,
  // proofs_sha256) ever gets read off exportRecord, this fails.
  const raw = readFileSync(ROUTE_PATH, "utf8");
  const src = stripComments(raw);
  const sealedFields = [
    "archive_r2_key",
    "manifest_r2_key",
    "archive_sha256",
    "manifest_sha256",
    "proofs_r2_key",
    "proofs_sha256",
  ];
  for (const f of sealedFields) {
    assert.ok(
      !new RegExp(`exportRecord[?.]\\s*${f}`).test(src),
      `exportRecord must never source sealed field ${f} — sealed identity is built in-memory this request`,
    );
  }
});

// ─── Regression: a data change between two builds yields a different seal hash ──

function makeReceiptRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    rowType: "receipt",
    lineId: null,
    matchStatus: null,
    receiptStatus: null,
    missingReceiptReason: null,
    cardholderName: null,
    businessTripStatus: null,
    receiptId: "r-abc-123",
    status: "reviewed",
    originalR2Key: "receipts/2024/01/r-abc-123/file.jpg",
    transactionDate: "2024-01-15",
    merchant: "Starbucks Tokyo",
    amountMinor: 650,
    currency: "JPY",
    expenseType: "misc",
    expenseCategoryCode: null,
    expenseCategoryJa: null,
    expenseCategoryEn: null,
    paymentPath: "CASH",
    businessPurpose: "Team coffee",
    attendees: [],
    invoiceRegistrationNumber: null,
    qualifiedInvoiceStatus: null,
    taxRate: null,
    taxAmountMinor: null,
    sourceType: null,
    counterpartyName: null,
    ...overrides,
  };
}

async function archiveSha256Of(rows: ExportRow[]): Promise<string> {
  // Mirror the route: archive_sha256 = hashCsvContent(buildMonthlyExportCsv(...)).
  // bomPrefixedCrlf wrapping is applied at the route before hashing too, but it
  // is a constant transform — omitting it does not change the content-sensitivity
  // property under test (a data change flips the hash either way).
  return hashCsvContent(buildMonthlyExportCsv(rows, new Map(), [], {}));
}

test("export-finalize-staleness: a data change between two builds produces a different archive_sha256 (the hash is content-sensitive)", async () => {
  // This is why the staleness gap matters: if the seal ever shipped a prior
  // build's bundle, the sealed archive_sha256 would differ from the fresh
  // build's. Proving the hash reacts to a data change is half of the regression;
  // the structural test above proves the one-shot path seals the fresh one.
  const buildA = [makeReceiptRow({ amountMinor: 650 })];
  const buildB = [makeReceiptRow({ amountMinor: 1000 })]; // amount changed
  const hashA = await archiveSha256Of(buildA);
  const hashB = await archiveSha256Of(buildB);
  assert.notEqual(hashA, hashB, "an amount change must yield a different archive_sha256");
});

test("export-finalize-staleness: adding/removing a receipt between two builds produces a different archive_sha256", async () => {
  const one = [makeReceiptRow({ receiptId: "r1" })];
  const two = [
    makeReceiptRow({ receiptId: "r1" }),
    makeReceiptRow({ receiptId: "r2", merchant: "Other", amountMinor: 200 }),
  ];
  const hashOne = await archiveSha256Of(one);
  const hashTwo = await archiveSha256Of(two);
  assert.notEqual(hashOne, hashTwo, "a row-count change must yield a different archive_sha256");
});

test("export-finalize-staleness: identical builds produce identical archive_sha256 (determinism anchor)", async () => {
  // Anchors the two tests above: the differing hashes are due to the data change,
  // not non-determinism in the hash/CSV pipeline.
  const rows = [makeReceiptRow({ amountMinor: 650 })];
  const h1 = await archiveSha256Of(rows);
  const h2 = await archiveSha256Of(rows);
  assert.equal(h1, h2);
});
