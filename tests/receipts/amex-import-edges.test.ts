// TASK-038: edge hardening around the AMEX sha-dedup branch and parser.
//
// Three layers, mirroring amex-import-contract.test.ts's source-reading
// style where behavior can't be exercised without live D1:
//  1. classifyExistingArtifact — the incomplete/heal/duplicate decision
//     table (F1). The route's sha-dedup branch is wired to it, and the heal
//     path must run under the ARTIFACT's own month, never the operator's
//     requested month.
//  2. statementMonthFitsPaymentDue — the F3 due-month vs selected-month
//     predicate.
//  3. The UI must actually render warnings on the duplicate branch (F2) —
//     the route sending them is worthless if the box shows only `message`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifyExistingArtifact,
  isIncompleteArtifact,
  type ExistingArtifactVerdict,
} from "@/lib/receipts/db";
import { statementMonthFitsPaymentDue } from "@/lib/receipts/validation";

// ─── classifyExistingArtifact: full decision table (F1) ──────────────────────

type ClassifierArtifact = Parameters<typeof classifyExistingArtifact>[0];

const MATRIX: Array<{
  label: string;
  artifact: ClassifierArtifact;
  lineCount: number;
  expected: ExistingArtifactVerdict;
}> = [
  // Zero-lines shapes → incomplete (existing purge-and-reimport path).
  {
    label: "uploaded + tc=40 + 0 lines (crashed mid-import)",
    artifact: { import_status: "uploaded", transaction_count: 40 },
    lineCount: 0,
    expected: "incomplete",
  },
  {
    label: "uploaded + tc=0 + 0 lines",
    artifact: { import_status: "uploaded", transaction_count: 0 },
    lineCount: 0,
    expected: "incomplete",
  },
  {
    label: "parsed + tc=40 + 0 lines (TASK-034 shape)",
    artifact: { import_status: "parsed", transaction_count: 40 },
    lineCount: 0,
    expected: "incomplete",
  },
  // Partial shapes → heal (complete in place; purge would destroy
  // reconciliation state — see the comment on classifyExistingArtifact).
  {
    label: "uploaded + tc=40 + 12 lines (chunks missing)",
    artifact: { import_status: "uploaded", transaction_count: 40 },
    lineCount: 12,
    expected: "heal",
  },
  {
    label: "uploaded + tc=40 + 40 lines (complete but unflipped)",
    artifact: { import_status: "uploaded", transaction_count: 40 },
    lineCount: 40,
    expected: "heal",
  },
  {
    label: "uploaded + tc=null + 5 lines",
    artifact: { import_status: "uploaded", transaction_count: null },
    lineCount: 5,
    expected: "heal",
  },
  {
    label: "parsed + tc=40 + 12 lines (partial under a green badge)",
    artifact: { import_status: "parsed", transaction_count: 40 },
    lineCount: 12,
    expected: "heal",
  },
  // Healthy shapes → duplicate.
  {
    label: "parsed + tc=40 + 40 lines",
    artifact: { import_status: "parsed", transaction_count: 40 },
    lineCount: 40,
    expected: "duplicate",
  },
  {
    label: "parsed + tc=40 + 45 lines (D1 dedup can't exceed… but tolerate >)",
    artifact: { import_status: "parsed", transaction_count: 40 },
    lineCount: 45,
    expected: "duplicate",
  },
  {
    label: "parsed + tc=0 + 0 lines",
    artifact: { import_status: "parsed", transaction_count: 0 },
    lineCount: 0,
    expected: "duplicate",
  },
  {
    label: "parsed + tc=null + 5 lines (can't prove partial)",
    artifact: { import_status: "parsed", transaction_count: null },
    lineCount: 5,
    expected: "duplicate",
  },
  // failed/replaced never reach this classifier via getAmexArtifactBySha256
  // (excluded in SQL), but if they did: duplicate, matching today's
  // isIncompleteArtifact behavior — never heal, never purge.
  {
    label: "failed + tc=21 + 0 lines → duplicate (not the purge shape here)",
    artifact: { import_status: "failed", transaction_count: 21 },
    lineCount: 0,
    expected: "duplicate",
  },
  {
    label: "failed + tc=21 + 5 lines",
    artifact: { import_status: "failed", transaction_count: 21 },
    lineCount: 5,
    expected: "duplicate",
  },
  {
    label: "replaced + tc=21 + 21 lines",
    artifact: { import_status: "replaced", transaction_count: 21 },
    lineCount: 21,
    expected: "duplicate",
  },
];

for (const { label, artifact, lineCount, expected } of MATRIX) {
  test(`classifyExistingArtifact: ${label} → ${expected}`, () => {
    assert.equal(classifyExistingArtifact(artifact, lineCount), expected);
  });
}

test("classifyExistingArtifact delegates to isIncompleteArtifact (incomplete ⟺ zero-lines purge shape)", () => {
  // The purge SQL mirror depends on isIncompleteArtifact's zero-lines-only
  // semantics; the classifier must delegate, not reimplement.
  for (const status of ["uploaded", "parsed", "failed", "replaced"] as const) {
    for (const tc of [0, 21, 40, null]) {
      const artifact = { import_status: status, transaction_count: tc };
      assert.equal(
        classifyExistingArtifact(artifact, 0) === "incomplete",
        isIncompleteArtifact(artifact, 0),
        `${status}/tc=${tc} at 0 lines must delegate to isIncompleteArtifact`,
      );
    }
  }
});

// ─── statementMonthFitsPaymentDue (F3) ───────────────────────────────────────

test("statementMonthFitsPaymentDue: due date inside the month → true", () => {
  assert.equal(statementMonthFitsPaymentDue("2026-10", "2026-10-05"), true);
});

test("statementMonthFitsPaymentDue: due date outside the month → false (the 2610 mis-slot shape)", () => {
  assert.equal(statementMonthFitsPaymentDue("2026-09", "2026-10-05"), false);
});

test("statementMonthFitsPaymentDue: absent due date → null (no verdict)", () => {
  assert.equal(statementMonthFitsPaymentDue("2026-09", null), null);
});

// ─── Route wiring (source assertions, comments stripped) ─────────────────────

const ROUTE_SRC_PATH = "app/api/receipts/amex/import/route.ts";
const ROUTE_SRC = readFileSync(ROUTE_SRC_PATH, "utf8")
  .split("\n")
  .filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  })
  .join("\n");

/** The sha-dedup branch: from the sha lookup to the replacement check. */
function dedupBranch(): string {
  const start = ROUTE_SRC.indexOf("getAmexArtifactBySha256(sha256)");
  assert.ok(start >= 0, "sha lookup not found in route source");
  // Anchor on the replacement check's own declaration — NOT on
  // getAmexArtifactByMonth(, which the heal path's newer-statement guard
  // also calls inside the dedup branch.
  const end = ROUTE_SRC.indexOf("const previousArtifact", start);
  assert.ok(end > start, "replacement check not found after sha lookup");
  return ROUTE_SRC.slice(start, end);
}

test("route wiring: sha-dedup branch decides via classifyExistingArtifact", () => {
  assert.match(
    dedupBranch(),
    /classifyExistingArtifact\(/,
    "the dedup branch must route through classifyExistingArtifact (F1)",
  );
});

test("route wiring: heal path parses + imports under the ARTIFACT's month, never the requested one", () => {
  const branch = dedupBranch();
  assert.match(
    branch,
    /parseAmexNetanswer\(\s*buffer,\s*existingBySha\.statement_month\s*\)/,
    "heal must parse with the artifact's own statement_month",
  );
  assert.match(
    branch,
    /netanswerLinesToImportInputs\(\s*heal\.lines,\s*existingBySha\.statement_month/,
    "heal must map import inputs under the artifact's own statement_month",
  );
  assert.match(
    branch,
    /importAmexLines\(/,
    "heal must re-import (idempotent completion), not just flip status",
  );
  assert.doesNotMatch(
    branch,
    /netanswerLinesToImportInputs\(\s*heal\.lines,\s*statementMonth/,
    "heal must NOT import under the operator's requested month",
  );
});

test("route wiring: heal keeps markPreviousArtifactsReplaced AFTER the import", () => {
  const branch = dedupBranch();
  const importAt = branch.indexOf("importAmexLines(");
  const replaceAt = branch.indexOf("markPreviousArtifactsReplaced(");
  assert.ok(importAt >= 0, "importAmexLines not found in dedup branch");
  assert.ok(replaceAt > importAt, "markPreviousArtifactsReplaced must come after importAmexLines");
});

test("route wiring: F3 due-month check is wired on the fresh path", () => {
  assert.match(
    ROUTE_SRC,
    /statementMonthFitsPaymentDue\(\s*statementMonth,\s*metadata\.paymentDueDate\s*\)/,
    "route must call statementMonthFitsPaymentDue after parsing (F3)",
  );
});

test("route wiring: wrong-month duplicate/heal responses carry warnings (F2)", () => {
  const branch = dedupBranch();
  assert.match(
    branch,
    /existingBySha\.statement_month !== statementMonth/,
    "the months-differ condition must be present",
  );
});

// ─── UI wiring (F2) ──────────────────────────────────────────────────────────

const FORM_SRC_PATH = "components/receipts/amex-import-form.tsx";
const FORM_SRC = readFileSync(FORM_SRC_PATH, "utf8");

test("amex-import-form: duplicate branch renders warnings, not just the message", () => {
  const start = FORM_SRC.indexOf("if (result.duplicate)");
  assert.ok(start >= 0, "duplicate branch not found in form source");
  // Region ends at the next early-return-free construct: the `const total`
  // line of the non-duplicate path.
  const end = FORM_SRC.indexOf("const total", start);
  assert.ok(end > start, "non-duplicate path not found after duplicate branch");
  const region = FORM_SRC.slice(start, end);
  assert.match(
    region,
    /result\.warnings/,
    "duplicate box must render result.warnings (F2)",
  );
});
