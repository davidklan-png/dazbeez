// THE DELIVERABLE OF #18 (ii): the capture completeness contract enforced
// structurally, not by convention. Two source-tree assertions. Assertion (2)
// is PRIMARY — it is the one that would have caught the mobile path's second
// INSERT (createMobileReceiptRecord) that the importer test alone is blind to.
//
// A capture is complete iff: (a) a receipt_records row [one insert path],
// (b) an is_original receipt_files row, (c) an enqueued job OR needs_render=1
// — all through captureReceipt (lib/receipts/capture.ts). This test guarantees
// the NEXT capture path can't bypass it the way the fourth (mobile) did.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Tracked source files (app/lib/components — NOT tests) containing `needle`. */
function sourceFilesContaining(needle: string): string[] {
  const out = execFileSync(
    "git",
    ["grep", "-l", "-e", needle, "app/", "lib/", "components/"],
    { encoding: "utf8" },
  );
  return out.trim().split("\n").filter(Boolean);
}

/** A real INSERT statement, not a comment: in this codebase all D1 SQL is a
 *  `.prepare(``...``)` template literal, so a real INSERT has a backtick before
 *  it on the line. Comments (e.g. mobile-upload.ts's history note) don't. */
const SQL_INSERT_INTO_RECEIPT_RECORDS = /`\s*INSERT\s+INTO\s+receipt_records/;

test("#18 enforcement (PRIMARY): exactly one INSERT INTO receipt_records — db.ts", () => {
  // createMobileReceiptRecord was a SECOND insert path with its own raw INSERT +
  // divergent columns; it bypassed createReceiptRecord entirely, so the importer
  // assertion below could not see it. After the merge, db.ts owns the only INSERT.
  // A future path that adds another INSERT fails this test.
  const candidates = sourceFilesContaining("INSERT INTO receipt_records");
  const offenders = candidates.filter((f) =>
    SQL_INSERT_INTO_RECEIPT_RECORDS.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(
    offenders.sort(),
    ["lib/receipts/db.ts"],
    `expected only db.ts to INSERT INTO receipt_records; found: ${offenders.join(", ")}`,
  );
});

test("#18 enforcement: createReceiptRecord has exactly one importer — capture.ts", () => {
  // The single door. db.ts defines createReceiptRecord (not an importer); every
  // capture path reaches it through captureReceipt. A new direct importer fails.
  const files = sourceFilesContaining("createReceiptRecord");
  const importers = files.filter((f) =>
    /import\s*\{[^}]*\bcreateReceiptRecord\b[^}]*\}\s*from/.test(
      readFileSync(f, "utf8"),
    ),
  );
  assert.deepEqual(
    importers.sort(),
    ["lib/receipts/capture.ts"],
    `expected only capture.ts to import createReceiptRecord; found: ${importers.join(", ")}`,
  );
});
