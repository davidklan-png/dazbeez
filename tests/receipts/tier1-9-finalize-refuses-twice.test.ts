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
// WHAT THIS PINS: that finalizeExport's finalize UPDATE still guards on
// status='draft' AND still throws when 0 rows match. Together those make a
// re-finalize a no-op-with-error instead of a re-write of sealed columns.
//
// WHY STRUCTURAL, NOT BEHAVIOURAL (opts.db seam): a behavioural fake would have
// to MODEL the row's status to catch a removed `AND status='draft'` guard —
// otherwise the fake returns changes=0 unconditionally and the test passes with
// the guard deleted (the T1-7 "passes for the wrong reason" trap). Modelling the
// row status is a structural check wearing a costume, so the honest pin is on
// the source. The trade: this asserts SQL TEXT, so a semantically-equivalent
// rewrite (a reordered WHERE, a different-but-valid guard formulation) will fail
// it spuriously. That trade is correct here — a false alarm on the sole sealing
// authority is far cheaper than silent removal.
//
// *** IF THIS TEST FAILS AFTER A REFACTOR: verify the refuse-twice guard still
// holds (the UPDATE still won't match an already-finalized row, and 0 changes
// still throws), then UPDATE THE PATTERN below to match the new formulation. DO
// NOT WEAKEN THE ASSERTION (e.g. drop the `status='draft'` requirement) to make
// it pass — that silently reintroduces the exact gap this test exists to close.
// This is the #175 failure mode: nobody wrote down what the test was for. ***

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
