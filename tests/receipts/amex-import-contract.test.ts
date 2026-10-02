// TASK-034: the importAmexLines INSERT shape enforced structurally, not by
// convention. 5a270ea shipped a placeholder with 25 value slots for a
// 26-column INSERT — every chunked INSERT failed in D1 behind an
// already-'parsed' artifact row, so two production statements imported zero
// lines while the upload history looked healthy. Unit tests with a mocked D1
// only see the binds the code *intends* to bind; they cannot see that the
// SQL text and the bind array have diverged. These source-reading assertions
// (same pattern as capture-contract.test.ts) pin that class of bug:
//
//  - placeholder slots (? + literals) == AMEX_LINE_INSERT_COLUMNS length,
//  - every binds.push(...) argument count == the bound-column count,
//  - both INSERT statements derive columns/placeholders from the ONE constant,
//  - db.ts stays the only INSERT site for amex_statement_lines.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  AMEX_LINE_INSERT_COLUMNS,
  AMEX_LINE_ROW_PLACEHOLDER,
  isIncompleteArtifact,
} from "@/lib/receipts/db";

const DB_SRC_PATH = "lib/receipts/db.ts";
const DB_SRC = readFileSync(DB_SRC_PATH, "utf8");

/** Comment LINES stripped so history notes ("the old placeholder was …") don't
 *  read as code. Same approach as capture-contract.test.ts. */
function stripCommentLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/** Slice a function's source region: from its declaration to the next
 *  top-level export. Brace-matching is deliberately avoided — the signature's
 *  Promise<{...}> return type makes the first `{` in the decl span the wrong
 *  anchor. The region may overshoot into trailing comments (stripped), never
 *  into the next function. */
function functionRegion(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found in ${DB_SRC_PATH}`);
  const next = src.indexOf("\nexport ", start + decl.length);
  return src.slice(start, next === -1 ? undefined : next);
}

/** Split a call's argument source on top-level commas (commas inside nested
 *  parens/brackets, e.g. newUuid(), are not separators). */
function topLevelArgs(argSrc: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of argSrc) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** A placeholder string's total value slots: bound ?s plus quoted literals. */
function slotCount(placeholder: string): number {
  return (placeholder.match(/\?/g) ?? []).length +
    (placeholder.match(/'[^']*'/g) ?? []).length;
}

const IMPORTAMEX_BODY = functionRegion(
  stripCommentLines(DB_SRC),
  "export async function importAmexLines(",
);

const BOUND_COLUMN_COUNT = AMEX_LINE_INSERT_COLUMNS.filter(
  (c) => !c.endsWith("!"),
).length;

// ─── the shipped invariant ────────────────────────────────────────────────────

test("importAmexLines contract: 26 columns, 25 bound + 1 literal slot", () => {
  assert.equal(AMEX_LINE_INSERT_COLUMNS.length, 26);
  assert.equal(BOUND_COLUMN_COUNT, 25);
  const literals = AMEX_LINE_INSERT_COLUMNS.length - BOUND_COLUMN_COUNT;
  assert.equal(literals, 1); // match_status!

  const qs = (AMEX_LINE_ROW_PLACEHOLDER.match(/\?/g) ?? []).length;
  const sqlLiterals = (AMEX_LINE_ROW_PLACEHOLDER.match(/'[^']*'/g) ?? []).length;
  assert.equal(qs, BOUND_COLUMN_COUNT, "one ? per bound column");
  assert.equal(
    qs + sqlLiterals,
    AMEX_LINE_INSERT_COLUMNS.length,
    "placeholder slots must equal INSERT column count",
  );
});

test("importAmexLines source: every binds.push(...) arg count == bound-column count", () => {
  const pushes = [...IMPORTAMEX_BODY.matchAll(/binds\.push\(([\s\S]*?)\);/g)];
  assert.ok(
    pushes.length >= 1,
    "no binds.push found — extraction broke, fail closed",
  );
  for (const m of pushes) {
    assert.equal(
      topLevelArgs(m[1]).length,
      BOUND_COLUMN_COUNT,
      `binds.push with ${topLevelArgs(m[1]).length} args must match the ${BOUND_COLUMN_COUNT} bound columns of AMEX_LINE_INSERT_COLUMNS (order contract — see its comment in db.ts)`,
    );
  }
});

test("importAmexLines source: both INSERTs derive columns + placeholders from the one constant", () => {
  const insertPositions = [
    ...IMPORTAMEX_BODY.matchAll(/INSERT INTO amex_statement_lines/g),
  ];
  assert.ok(
    insertPositions.length >= 1,
    "no INSERT INTO amex_statement_lines in importAmexLines — fail closed",
  );

  for (const m of insertPositions) {
    const from = m.index ?? 0;
    const valuesAt = IMPORTAMEX_BODY.indexOf("VALUES", from);
    const conflictAt = IMPORTAMEX_BODY.indexOf("ON CONFLICT", from);
    assert.ok(valuesAt > from, "INSERT has a VALUES clause");
    assert.ok(conflictAt > valuesAt, "INSERT has an ON CONFLICT clause");
    const columnListSrc = IMPORTAMEX_BODY.slice(from, valuesAt);
    assert.match(
      columnListSrc,
      /AMEX_LINE_INSERT_COLUMN_LIST\.join/,
      "column list must be derived from AMEX_LINE_INSERT_COLUMNS, not hand-written",
    );
    const valuesSrc = IMPORTAMEX_BODY.slice(valuesAt, conflictAt);
    assert.match(
      valuesSrc,
      /\$\{placeholders\}/,
      "VALUES must interpolate the shared row placeholder",
    );
  }

  // No hand-written placeholder literal anywhere in the function: a reverted
  // "(?, ?, …)" string is exactly how the 25-vs-26 divergence came back.
  assert.doesNotMatch(
    IMPORTAMEX_BODY,
    /["'`]\(\s*\?/,
    "hand-written placeholder string literal — derive from AMEX_LINE_ROW_PLACEHOLDER instead",
  );
  assert.match(
    IMPORTAMEX_BODY,
    /AMEX_LINE_ROW_PLACEHOLDER/,
    "function must build placeholders from the shared constant",
  );
});

test("repo-wide guard: db.ts is the only INSERT site for amex_statement_lines", () => {
  // Same shape as capture-contract's PRIMARY assertion: a second module
  // hand-rolling this INSERT would be invisible to every check above.
  const out = execFileSync(
    "git",
    ["grep", "-l", "-E", "INSERT.*amex_statement_lines", "app/", "lib/", "components/"],
    { encoding: "utf8" },
  );
  const offenders = out.trim().split("\n").filter(Boolean);
  assert.deepEqual(
    offenders.sort(),
    [DB_SRC_PATH],
    `expected only db.ts to INSERT into amex_statement_lines; found: ${offenders.join(", ")}`,
  );
});

// ─── fixtures: the test must fail on the known bug, not just pass on the fix ──

test("fixture: the shipped 25-slot placeholder (the TASK-034 bug) fails the slot invariant", () => {
  // Verbatim from db.ts as shipped by 5a270ea (24 ? + the literal = 25 slots
  // for a 26-column INSERT).
  const BUGGED =
    "(?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  assert.equal(slotCount(BUGGED), 25); // one slot short of the 26 columns
  assert.notEqual(
    slotCount(BUGGED),
    AMEX_LINE_INSERT_COLUMNS.length,
    "the bugged placeholder must be detectable by the slot invariant",
  );
});

// ─── isIncompleteArtifact ───────────────────────────────────────────────────

test("isIncompleteArtifact: parsed + transactions + zero lines == incomplete", () => {
  assert.equal(
    isIncompleteArtifact({ import_status: "parsed", transaction_count: 21 }, 0),
    true,
  );
});

test("isIncompleteArtifact: parsed + transactions + lines == healthy duplicate", () => {
  assert.equal(
    isIncompleteArtifact({ import_status: "parsed", transaction_count: 21 }, 21),
    false,
  );
});

test("isIncompleteArtifact: failed artifacts keep existing purge behavior", () => {
  assert.equal(
    isIncompleteArtifact({ import_status: "failed", transaction_count: 21 }, 0),
    false,
  );
});

test("isIncompleteArtifact: parsed with zero transactions is not incomplete", () => {
  assert.equal(
    isIncompleteArtifact({ import_status: "parsed", transaction_count: 0 }, 0),
    false,
  );
});

test("isIncompleteArtifact: uploaded + transactions + zero lines == incomplete (crashed mid-import)", () => {
  assert.equal(
    isIncompleteArtifact({ import_status: "uploaded", transaction_count: 21 }, 0),
    true,
  );
});

test("isIncompleteArtifact: uploaded + zero transactions + zero lines == incomplete", () => {
  assert.equal(
    isIncompleteArtifact({ import_status: "uploaded", transaction_count: 0 }, 0),
    true,
  );
});

test("isIncompleteArtifact: uploaded + lines == complete (heal-in-place duplicate)", () => {
  assert.equal(
    isIncompleteArtifact({ import_status: "uploaded", transaction_count: 21 }, 21),
    false,
  );
});
