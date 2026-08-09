// THE DELIVERABLE OF #18 (ii): the capture completeness contract enforced
// structurally, not by convention. Two source-tree assertions. Assertion (2)
// is PRIMARY — it is the one that would have caught the mobile path's second
// INSERT (createMobileReceiptRecord) that the importer test alone is blind to.
//
// A capture is complete iff: (a) a receipt_records row [one insert path],
// (b) an is_original receipt_files row, (c) an enqueued job OR needs_render=1
// — all through captureReceipt (lib/receipts/capture.ts). This test guarantees
// the NEXT capture path can't bypass it the way the fourth (mobile) did.
//
// SCOPE: app/ lib/ components/ only. scripts/ is DELIBERATELY out of scope —
// one-off scripts (e.g. backfill-missing-manifest.ts) legitimately run ad-hoc
// receipt SQL; the contract governs the runtime capture paths, not tooling.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** A real INSERT into receipt_records in ANY form — including INSERT OR IGNORE
 *  INTO / INSERT OR REPLACE INTO, which a future idempotent capture path would
 *  reach for and which a naive "INSERT INTO receipt_records" grep misses. The
 *  optional `OR <word>` clause is the part a weaker test would let through. */
const OFFENDER = /INSERT\s+(OR\s+\w+\s+)?INTO\s+receipt_records/;

/** Strip comment LINES (not inline) so a history comment like mobile-upload.ts's
 *  "// the second INSERT INTO receipt_records" doesn't false-positive. Solving
 *  the comment problem by requiring backticks instead opens a worse hole: a
 *  double-quoted .prepare("INSERT INTO …") becomes a candidate but matches no
 *  backtick regex. Stripping comments keeps the test honest AND quote-agnostic. */
function stripCommentLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/** Candidate source files (app/lib/components — NOT tests, NOT scripts/) whose
 *  text mentions an INSERT … receipt_records. Broad on purpose: catches INSERT
 *  OR IGNORE INTO too (a plain "INSERT INTO receipt_records" grep would miss it). */
function candidateFiles(): string[] {
  const out = execFileSync(
    "git",
    ["grep", "-l", "-E", "INSERT.*receipt_records", "app/", "lib/", "components/"],
    { encoding: "utf8" },
  );
  return out.trim().split("\n").filter(Boolean);
}

test("#18 enforcement (PRIMARY): exactly one INSERT into receipt_records — db.ts", () => {
  // createMobileReceiptRecord was a SECOND insert path with its own raw INSERT +
  // divergent columns; it bypassed createReceiptRecord entirely, so the importer
  // assertion below could not see it. After the merge, db.ts owns the only INSERT.
  // A future path that adds another INSERT — including INSERT OR IGNORE — fails
  // this test. Comment lines are stripped so history notes don't read as code.
  const offenders = candidateFiles().filter((f) =>
    OFFENDER.test(stripCommentLines(readFileSync(f, "utf8"))),
  );
  assert.deepEqual(
    offenders.sort(),
    ["lib/receipts/db.ts"],
    `expected only db.ts to INSERT into receipt_records; found: ${offenders.join(", ")}`,
  );
});

test("#18 enforcement: createReceiptRecord has exactly one importer — capture.ts", () => {
  // The single door. db.ts defines createReceiptRecord (not an importer); every
  // capture path reaches it through captureReceipt. A new direct importer fails.
  const out = execFileSync(
    "git",
    ["grep", "-l", "-e", "createReceiptRecord", "app/", "lib/", "components/"],
    { encoding: "utf8" },
  );
  const files = out.trim().split("\n").filter(Boolean);
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

// ─── fixtures: the test must not fail open on the known evasions ─────────────

test("offender regex catches INSERT OR IGNORE INTO (the idempotent-capture evasion)", () => {
  // A future idempotent capture path would reach for INSERT OR IGNORE; the old
  // "INSERT INTO receipt_records" candidate grep never matched this string, so
  // the file was never read. The offender regex + broad candidate grep catch it.
  assert.equal(
    OFFENDER.test("await db.prepare(`INSERT OR IGNORE INTO receipt_records (id) VALUES (?)`)"),
    true,
  );
  assert.equal(
    OFFENDER.test("INSERT OR REPLACE INTO receipt_records (id) VALUES (?)"),
    true,
  );
});

test("offender regex is quote-agnostic (backtick AND double-quoted .prepare)", () => {
  // The old backtick-requiring regex let a double-quoted .prepare("INSERT …")
  // through. This regex matches either quote style.
  assert.equal(
    OFFENDER.test('db.prepare("INSERT INTO receipt_records (id) VALUES (?)")'),
    true,
  );
  assert.equal(
    OFFENDER.test("db.prepare(`INSERT INTO receipt_records (id) VALUES (?)`)"),
    true,
  );
});

test("comment lines are stripped (history notes don't false-positive)", () => {
  // mobile-upload.ts carries a comment documenting that createMobileReceiptRecord
  // was the second INSERT path. That's history, not code — stripping comment
  // lines keeps it out of the offender set without weakening the regex.
  const withComment =
    "// createMobileReceiptRecord was the second INSERT INTO receipt_records (raw, …)\nexport function findMobileReceiptByIdempotency() {}\n";
  assert.equal(OFFENDER.test(stripCommentLines(withComment)), false);
  const withCode =
    "await db.prepare(`INSERT INTO receipt_records (id) VALUES (?)`);\n";
  assert.equal(OFFENDER.test(stripCommentLines(withCode)), true);
});
