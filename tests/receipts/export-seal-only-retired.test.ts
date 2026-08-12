import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Part B of the one-shot finalize work (decision 3): the seal-only finalize
// branch in app/api/receipts/export/[month]/route.ts is RETIRED. There is now
// exactly one way to seal a month — the one-shot POST /api/receipts/export/month.
//
// These structural assertions pin that the old route (a) returns 410 for a plain
// finalize so no caller can seal through it, (b) no longer even imports
// finalizeExport — so it COULD NOT seal even if the branch were re-added by
// mistake — while (c) the ?correction=true revision branch is untouched. The
// one-shot path's safety is pinned separately (export-finalize-staleness.test.ts).

const ROUTE = "app/api/receipts/export/[month]/route.ts";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

const src = stripComments(readFileSync(ROUTE, "utf8"));

test("retired seal-only [month] POST: a plain finalize returns 410 pointing at the one-shot path", () => {
  assert.ok(/status:\s*410/.test(src), "the retired branch returns 410, not 200/422");
  assert.ok(
    /\/api\/receipts\/export\/month/.test(src),
    "the 410 names the one-shot path so callers know where to go",
  );
});

test("retired seal-only [month] POST can no longer seal: finalizeExport is not imported or referenced", () => {
  // The strongest form of "seals nothing": the sealing function is not even in
  // the file. Re-adding the old else-branch verbatim would fail this immediately.
  assert.ok(
    !/finalizeExport/.test(src),
    "finalizeExport must not be imported or referenced — this route no longer seals",
  );
});

test("?correction=true on [month] still creates a revision (the revision branch is untouched)", () => {
  assert.ok(/get\("correction"\)\s*===\s*"true"/.test(src), "the correction flag is still read");
  assert.ok(/createExportRevision\(/.test(src), "revision creation is still wired");
});
