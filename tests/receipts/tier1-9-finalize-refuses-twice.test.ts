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

// UPDATED for the seal boundary (0042, 2026-11): finalizeExport is gone; the
// sealing authority is publishExportBundle (lib/receipts/export-publication.ts).
// The refuse-twice guard is stronger now: the publication UPDATE flips to
// 'finalized' only WHERE the row is still 'draft' AND holds THIS attempt's
// token AND an unexpired lease, and the IMMEDIATELY-following audit INSERT
// asserts changes()=1 through receipt_audit_log.actor NOT NULL — a zero-row
// CAS (already finalized, lost token, expired lease) becomes a SQL error that
// rolls back the whole publication batch. Same doctrine, new formulation.

test("T1-9: the publication CAS flips to 'finalized' only on a live draft+token lease, and a zero-row CAS fails in SQL (refuses to run twice)", () => {
  const src = readFileSync("lib/receipts/export-publication.ts", "utf8");
  const start = src.indexOf("export async function publishExportBundle");
  assert.ok(start > -1, "publishExportBundle not found");
  const end = src.indexOf("export async function", start + 1);
  const body = src.slice(start, end);

  // The guard: flip to 'finalized' only where the row is still 'draft' under
  // this attempt's live lease. Removing any arm lets a re-finalize or a loser
  // match the sealed row.
  assert.ok(
    /status = 'finalized'[\s\S]*?WHERE id = \?[\s\S]*?AND status = 'draft'[\s\S]*?AND sealing_token = \?[\s\S]*?AND sealing_expires_at > CAST\(strftime\('%s','now'\) AS INTEGER\)/m.test(body),
    "the publication UPDATE must seal only a still-draft row holding this token with an unexpired lease",
  );
  // The enforcement: the audit INSERT immediately after asserts changes()=1 via
  // the NOT NULL actor — a lost CAS is a SQL error inside the batch, not a
  // silent no-op. Do not weaken this to INSERT OR IGNORE.
  assert.ok(
    /CASE WHEN changes\(\) = 1 THEN \? ELSE NULL END/.test(body),
    "the audit assertion must turn a zero-row CAS into a NOT NULL constraint failure",
  );
  assert.ok(
    !/INSERT OR IGNORE INTO receipt_audit_log/.test(body),
    "never INSERT OR IGNORE the assertion audit — that would swallow the CAS loss",
  );
});
