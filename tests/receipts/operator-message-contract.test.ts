// The structural invariant behind the 2026-06 message-loss fix, asserted at the
// source tree (same shape as the capture-contract test for #18). The bug hid
// partly because no test pinned the old lockstep — so breaking it was silent.
//
// operator_message_updated_at is the DECISION timestamp:
//   - written ONLY by updateExportOperatorMessage (the PATCH /message route: a
//     saved preface, or an explicit "no message this month");
//   - NEVER written by recordExportBundle (rebuild + finalize), because doing so
//     at rebuild would forge a decision the operator never made and destroy the
//     NULL signal that the message_not_reviewed finalize gate depends on.
// NULL ⇒ never decided ⇒ message_not_reviewed blocks finalize (the downstream
// assertion lives in month-closing.test.ts; this file pins the upstream cause:
// a rebuild cannot clear NULL because it does not touch the timestamp).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Strip full-line comments (// …, * …, /*) so docstrings discussing the
 *  timestamp don't read as code. Mirrors the capture-contract test. */
function stripCommentLines(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/** The body of a named `export async function`, up to the next one. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} not found in db.ts`);
  const next = src.indexOf("export async function", start + 10);
  return src.slice(start, next === -1 ? undefined : next);
}

const DB = stripCommentLines(readFileSync("lib/receipts/db.ts", "utf8"));

test("recordExportBundle (rebuild + finalize) advances bundle_built_at but NOT operator_message_updated_at", () => {
  const body = functionBody(DB, "recordExportBundle");
  // A rebuild clears message_stale by advancing bundle_built_at past the save
  // timestamp — that is the ONLY timestamp it touches.
  assert.ok(
    /bundle_built_at\s*=/.test(body),
    "recordExportBundle advances bundle_built_at (this is what clears message_stale on rebuild)",
  );
  // …and it must NOT write the decision timestamp. The old lockstep wrote both
  // to now; that forged a decision at rebuild and is why NULL could not be
  // trusted as "never decided."
  assert.ok(
    !/operator_message_updated_at\s*=/.test(body),
    "recordExportBundle must NOT write operator_message_updated_at — a rebuild/finalize forging a decision would destroy the NULL signal message_not_reviewed depends on",
  );
});

test("updateExportOperatorMessage is the SOLE writer of operator_message_updated_at", () => {
  assert.ok(
    /operator_message_updated_at\s*=/.test(functionBody(DB, "updateExportOperatorMessage")),
    "updateExportOperatorMessage must write the decision timestamp (save / 'no message')",
  );
  // And nothing outside db.ts writes it.
  const writers = execFileSync(
    "grep",
    ["-rlE", "operator_message_updated_at\\s*=", "lib/", "app/"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    writers,
    ["lib/receipts/db.ts"],
    "operator_message_updated_at may be written only in db.ts (by updateExportOperatorMessage)",
  );
});
