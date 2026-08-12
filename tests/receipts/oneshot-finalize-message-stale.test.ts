import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateMonthReadyForExportCoreDetailed,
  type ExportBundle,
  type ValidateMonthReadyInput,
} from "@/lib/receipts/month-closing";
import type { AmexReconciliation } from "@/lib/receipts/types";

// PR #179 hold trace (2026-08-12): does one-shot finalize hit `message_stale` on
// the COMMON path — a month the operator has already previewed (an existing
// built draft)? The architect's read of the route, verified below, is YES.
//
// The one-shot finalize sequence in app/api/receipts/export/month/route.ts is:
//   createExport(month)                          → reuses the existing draft
//                                                  (bundle_built_at retained)
//   updateExportOperatorMessage(exportId, msg)   → operator_message_updated_at = now
//   validateMonthReadyForExport(month, ...)      → reads the row
//   ... build / stage / finalizeExport ...        → happens AFTER the gate
//
// At validation time bundle_built_at is the OLD preview timestamp and
// operator_message_updated_at is `now`, so gate 1.5 sees
// `operatorMessageUpdatedAt > bundleBuiltAt` and emits `message_stale` — telling
// the operator to "Rebuild the draft before finalizing" on a path that is about
// to rebuild inside the very same request. It does NOT fire when there was no
// prior draft (bundle_built_at NULL short-circuits the check), which is why this
// went unseen: the gate landed in #169 and the UI wiring only just arrived.
//
// These three tests pin the chain permanently. Together they prove the one-shot
// returns 422 message_stale on the common path. (The fix is NOT implemented
// here — the architect holds that decision.)

const MONTH = "2026-07";

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

test("one-shot message_stale trace: the gate emits message_stale for the timestamp combo the one-shot route produces", () => {
  // This is the combination the route creates on the common path: an existing
  // built draft (bundleBuiltAt set) whose operator_message_updated_at was just
  // bumped past it by updateExportOperatorMessage. Everything else is clean, so
  // message_stale is the only blocker that can fire.
  const blockers = validateMonthReadyForExportCoreDetailed(
    cleanInput({
      exportBuild: {
        bundleBuiltAt: "2026-07-10T00:00:00Z", // an earlier preview/rebuild
        operatorMessageUpdatedAt: "2026-07-12T00:00:00Z", // updateExportOperatorMessage = now
      },
    }),
  );
  const stale = blockers.find((b) => b.code === "message_stale");
  assert.ok(
    stale,
    `expected message_stale for the one-shot combo; got [${blockers.map((b) => b.code).join(", ")}]`,
  );
});

test("one-shot message_stale trace: the route writes the operator message BEFORE validating and builds AFTER — so validate sees stale bundle_built_at", () => {
  const route = readFileSync("app/api/receipts/export/month/route.ts", "utf8");
  const msgWrite = route.indexOf("updateExportOperatorMessage(");
  const validate = route.indexOf("validateMonthReadyForExport(");
  const build = route.indexOf("archiveBundle("); // the first build/stage side-effect
  assert.ok(msgWrite > -1 && validate > -1 && build > -1, "expected all three call sites present");
  assert.ok(
    msgWrite < validate,
    "the operator-message write (bumps operator_message_updated_at to now) must run BEFORE validate",
  );
  assert.ok(
    validate < build,
    "validate runs BEFORE the build/stage, so at validate time bundle_built_at is the old value ⇒ message_stale",
  );
});

test("one-shot message_stale trace: createExport reuses an existing draft, so bundle_built_at survives into the gate (the 'already previewed' state)", () => {
  const db = readFileSync("lib/receipts/db.ts", "utf8");
  const start = db.indexOf("export async function createExport");
  const end = db.indexOf("export async function", start + 1);
  const createExport = db.slice(start, end);
  assert.ok(
    /if \(draft\) return draft\.id/.test(createExport),
    "createExport returns the existing draft id without resetting bundle_built_at — the prior preview's timestamp is what the gate compares against",
  );
});
