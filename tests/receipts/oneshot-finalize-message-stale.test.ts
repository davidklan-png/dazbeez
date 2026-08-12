import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateMonthReadyForExportCoreDetailed,
  type ExportBundle,
  type ValidateMonthReadyInput,
} from "@/lib/receipts/month-closing";
import type { AmexReconciliation } from "@/lib/receipts/types";

// Fix (a) for PR #179 (architect, 2026-08-12): the one-shot finalize path rebuilds
// within the same request, so `message_stale` is inapplicable on it — its purpose
// (force a rebuild so the sealed bytes match the edited message) is satisfied by
// construction. The gate now takes `bundleRebuiltInRequest`; when set, gate 1.5
// skips. This file pins:
//   - the gate STILL emits message_stale by default (rebuild/preview paths — the
//     fix must not leak into the preview tile);
//   - the gate SKIPS message_stale when bundleRebuiltInRequest is set (one-shot);
//   - the route sets that option ONLY in the one-shot finalize branch (never the
//     rebuild path), as a code-path invariant — not derived from the request body.
//
// Pre-fix context (why the option is needed): the route writes the operator
// message (operator_message_updated_at = now) BEFORE it validates, and builds
// AFTER, so at validate time bundle_built_at is the old preview value and the
// timestamps are inverted. createExport reuses the existing draft, so that prior
// preview's bundle_built_at is what the gate would compare against.

const MONTH = "2026-07";
const ROUTE = "app/api/receipts/export/month/route.ts";

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

function makeBundle(): ExportBundle {
  return {
    rows: [],
    receipts: [],
    amexLines: [],
    attendeeMap: new Map(),
    attendeeDirectory: [],
    amexAttendees: {},
    items: [],
  };
}

function cleanInput(
  over: Partial<ValidateMonthReadyInput>,
): ValidateMonthReadyInput {
  const reconciliation: AmexReconciliation = {
    id: "recon-1",
    statement_month: MONTH,
    statement_artifact_id: null,
    status: "finalized",
    manifest_r2_key: "manifests/2026-07.csv",
    manifest_sha256: "sha",
    line_count: 1,
    matched_count: 1,
    no_receipt_count: 0,
    created_by: "test",
    created_at: "2026-07-15T00:00:00Z",
    finalized_by: "test",
    finalized_at: "2026-07-15T00:00:00Z",
  };
  return {
    month: MONTH,
    reconciliation,
    bundle: makeBundle(),
    unknownReceipts: [],
    unreviewedReceipts: [],
    amexAttendees: {},
    complianceSummary: { blockers: 0, warnings: 0 },
    complianceSettings: { export_block_on_warnings: false },
    crossMonthMatchedLines: [],
    receiptFileCounts: new Map(),
    ...over,
  };
}

const INVERTED = {
  exportBuild: {
    bundleBuiltAt: "2026-07-10T00:00:00Z", // an earlier preview/rebuild
    operatorMessageUpdatedAt: "2026-07-12T00:00:00Z", // updateExportOperatorMessage = now
  },
};

test("one-shot message_stale: by DEFAULT the gate emits message_stale for the inverted-timestamp combo (rebuild/preview paths)", () => {
  // The fix must not leak into the preview path. The export page's blocker tile
  // calls the gate without bundleRebuiltInRequest, so a stale preview still
  // reports message_stale there (correctly — the downloadable draft IS stale).
  const blockers = validateMonthReadyForExportCoreDetailed(cleanInput(INVERTED));
  assert.ok(
    blockers.some((b) => b.code === "message_stale"),
    `expected message_stale by default; got [${blockers.map((b) => b.code).join(", ")}]`,
  );
});

test("one-shot message_stale: the gate SKIPS message_stale when bundleRebuiltInRequest is set (the one-shot finalize path)", () => {
  // The one-shot path rebuilds within the same request, so a stale
  // bundle_built_at cannot survive to the seal — message_stale is absent there.
  const blockers = validateMonthReadyForExportCoreDetailed(
    cleanInput({ ...INVERTED, bundleRebuiltInRequest: true }),
  );
  assert.ok(
    !blockers.some((b) => b.code === "message_stale"),
    `message_stale must be absent on the one-shot path; got [${blockers.map((b) => b.code).join(", ")}]`,
  );
});

test("one-shot route: the finalize branch writes the operator message BEFORE validating and builds AFTER (the combo-producing ordering the option exists to defuse)", () => {
  const route = readFileSync(ROUTE, "utf8");
  const msgWrite = route.indexOf("updateExportOperatorMessage(");
  const validate = route.indexOf("validateMonthReadyForExport(");
  const build = route.indexOf("archiveBundle("); // the first build/stage side-effect
  assert.ok(msgWrite > -1 && validate > -1 && build > -1, "expected all three call sites present");
  assert.ok(
    msgWrite < validate,
    "the operator-message write (bumps operator_message_updated_at to now) runs BEFORE validate",
  );
  assert.ok(
    validate < build,
    "validate runs BEFORE the build/stage — without the option this would emit message_stale",
  );
});

test("one-shot route: the finalize branch sets { bundleRebuiltInRequest: true } at its validate call, and ONLY there (rebuild-only path does not set it)", () => {
  const src = stripComments(readFileSync(ROUTE, "utf8"));
  // Exactly one code occurrence — the option is a code-path invariant set at the
  // single finalize call site, never derived from the request body and never on
  // the rebuild-only (finalize:false) path (which does not call this gate).
  assert.equal(
    src.split("bundleRebuiltInRequest").length - 1,
    1,
    "bundleRebuiltInRequest appears exactly once in code",
  );
  assert.ok(
    /bundleRebuiltInRequest:\s*true/.test(src),
    "set to literal true — a property of the code path (the one-shot rebuilds in-request), not a client preference",
  );
  const finalizeStart = src.indexOf("if (body.finalize)");
  const optIdx = src.indexOf("bundleRebuiltInRequest");
  assert.ok(
    optIdx > finalizeStart,
    "the option is set inside the finalize branch only — the rebuild-only path must not set it",
  );
});

test("one-shot message_stale: createExport reuses an existing draft, so bundle_built_at survives into the gate (the 'already previewed' state)", () => {
  const db = readFileSync("lib/receipts/db.ts", "utf8");
  const start = db.indexOf("export async function createExport");
  const end = db.indexOf("export async function", start + 1);
  const createExport = db.slice(start, end);
  assert.ok(
    /if \(draft\) return draft\.id/.test(createExport),
    "createExport returns the existing draft id without resetting bundle_built_at — the prior preview's timestamp is what the gate compares against",
  );
});

test("one-shot message_stale: the review page (the one-shot finalize surface) sets bundleRebuiltInRequest — so its FinalizeCard blockerCount excludes message_stale", () => {
  // Without this, gateBlockers would include message_stale and the FinalizeCard
  // would disable Finalize — defeating fix (a) from the UI. The review page IS
  // the one-shot path's surface (the card POSTs finalize:true), so its gate
  // verdict must match what the one-shot enforces.
  const src = stripComments(
    readFileSync("app/(receipt-system)/receipts/export/[month]/review/page.tsx", "utf8"),
  );
  const gateCallIdx = src.indexOf("validateMonthReadyForExportDetailed(");
  const optIdx = src.indexOf("bundleRebuiltInRequest", gateCallIdx);
  assert.ok(
    gateCallIdx > -1 && optIdx > gateCallIdx,
    "the review page passes bundleRebuiltInRequest to its gate call",
  );
});

test("one-shot message_stale: deriveMonthStage does NOT set bundleRebuiltInRequest — message_stale still reaches the pipeline as a Draft advisory", () => {
  // The pipeline is wayfinding, not enforcement. It reads the gate at default so
  // a stale preview surfaces as a Draft advisory ("rebuild to refresh") — never a
  // block, never hidden.
  const src = stripComments(readFileSync("lib/receipts/month-stage.ts", "utf8"));
  assert.ok(
    !/bundleRebuiltInRequest/.test(src),
    "deriveMonthStage reads the gate WITHOUT the option so message_stale surfaces as a Draft advisory, not a block",
  );
});
