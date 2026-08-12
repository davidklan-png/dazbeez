import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// T1-9 (rank 2, docs/audits/2026-08-backlog-questions.md §6): finalizeExport
// refuses to run twice — re-finalize must NOT re-write sealed columns
// (finalization_hash / finalized_at) on an already-sealed row. The guard is the
// finalize UPDATE's `WHERE id = ? AND status = 'draft'` plus the throw when it
// matches 0 rows (the row is already 'finalized'). Both currently held by a
// comment only.
//
// Approach — STRUCTURAL, not the opts.db seam. A behavioral seam would need the
// fake to MODEL the row's status to catch a removed guard (otherwise the fake
// returns changes=0 unconditionally and the test still passes with the guard
// deleted — the T1-7 "passes for the wrong reason" trap). Modelling the row
// status is a structural check in disguise, so the cleaner pin is on the source:
// assert the guard + the throw are present in finalizeExport's body. Removing
// `AND status = 'draft'` from the finalize UPDATE fails this test (verified).

test("T1-9: finalizeExport's finalize UPDATE guards on status='draft' AND throws on 0 changes (refuses to run twice)", () => {
  const src = readFileSync("lib/receipts/db.ts", "utf8");
  // Scope to finalizeExport's own body (recordExportBundle also has a
  // status='draft' WHERE, but for staging — a different UPDATE). The refuse-twice
  // guard is the one that SETs status='finalized'.
  const start = src.indexOf("export async function finalizeExport");
  assert.ok(start > -1, "finalizeExport not found");
  const end = src.indexOf("export async function", start + 1);
  const body = src.slice(start, end);

  // The guard: flip to 'finalized' only where the row is still 'draft'. Removing
  // `AND status = 'draft'` would let a re-finalize match the sealed row.
  assert.ok(
    /SET status = 'finalized'[\s\S]*?WHERE id = \? AND status = 'draft'/m.test(body),
    "the finalize UPDATE must SET status='finalized' only WHERE status='draft' — the refuse-twice guard",
  );
  // The enforcement: throw when the guard matches 0 rows (already finalized).
  assert.ok(
    /could not be finalized/i.test(body),
    "finalizeExport must throw when 0 rows match (the row is already finalized) — sealed immutability",
  );
});
