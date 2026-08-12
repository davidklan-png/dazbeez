import test from "node:test";
import assert from "node:assert/strict";
import {
  planExportDeletion,
  type ExportDeletionContext,
  type ExportDeletionRequest,
} from "@/lib/receipts/export-deletion";
import type { ReceiptExport } from "@/lib/receipts/types";

// Backlog #26 — the refusal paths for sealed-export deletion. The committed
// script is the only sanctioned way to delete a sealed export; this pins that it
// refuses every case it must. Fail-then-pass verified: removing the refusal
// guards makes these fail.

const ID = "bfa94a26-1111-2222-3333-444455556666";
const MONTH = "2026-06";

function makeExport(over: Partial<ReceiptExport> = {}): ReceiptExport {
  return {
    id: ID,
    export_month: MONTH,
    status: "finalized",
    archive_r2_key: `exports/${MONTH}/${ID}-receipts.csv`,
    manifest_r2_key: `exports/${MONTH}/${ID}-manifest.csv`,
    archive_sha256: "sha-archive",
    created_by: "test",
    created_at: "2026-07-12T00:00:00Z",
    finalized_at: "2026-07-14T00:00:00Z",
    legal_hold: 1,
    export_revision: 1,
    proofs_r2_key: `exports/${MONTH}/${ID}-proofs.zip`,
    ...over,
  };
}

function req(over: Partial<ExportDeletionRequest> = {}): ExportDeletionRequest {
  return {
    exportId: ID,
    month: MONTH,
    legalHoldException: "operator-authorized removal of pre-close production-test seal",
    ...over,
  };
}

function ctx(over: Partial<ExportDeletionContext> = {}): ExportDeletionContext {
  return { exportRow: makeExport(), deliveries: [], ...over };
}

function refuseCode(r: { ok: boolean; reason?: string }): string {
  assert.equal(r.ok, false, "expected a refusal");
  return r.reason ?? "";
}

// ─── Required-flag refusals ──────────────────────────────────────────────────

test("refuses: missing export id (no default, no 'all drafts')", () => {
  assert.match(refuseCode(planExportDeletion(req({ exportId: "" }), ctx())), /export id is required/);
});

test("refuses: wildcard in export id", () => {
  assert.match(refuseCode(planExportDeletion(req({ exportId: "*" }), ctx())), /wildcards/);
  assert.match(refuseCode(planExportDeletion(req({ exportId: "%draft" }), ctx())), /wildcards/);
});

test("refuses: month missing / malformed / wildcarded", () => {
  assert.match(refuseCode(planExportDeletion(req({ month: "" }), ctx())), /month is required as YYYY-MM/);
  assert.match(refuseCode(planExportDeletion(req({ month: "2026-6" }), ctx())), /month is required as YYYY-MM/);
  assert.match(refuseCode(planExportDeletion(req({ month: "2026-%%" }), ctx())), /wildcards/);
});

test("refuses: missing legal-hold exception (legal_hold defaults to 1)", () => {
  assert.match(
    refuseCode(planExportDeletion(req({ legalHoldException: "" }), ctx())),
    /legal-hold exception/,
  );
  assert.match(
    refuseCode(planExportDeletion(req({ legalHoldException: "   " }), ctx())),
    /legal-hold exception/,
  );
});

// ─── Data refusals ───────────────────────────────────────────────────────────

test("refuses: export not found", () => {
  assert.match(
    refuseCode(planExportDeletion(req(), ctx({ exportRow: null }))),
    /no receipt_exports row found/,
  );
});

test("refuses: id mismatch (the row found isn't the one requested)", () => {
  assert.match(
    refuseCode(planExportDeletion(req(), ctx({ exportRow: makeExport({ id: "other-id" }) }))),
    /id mismatch/,
  );
});

test("refuses: month mismatch (the row belongs to a different month)", () => {
  assert.match(
    refuseCode(
      planExportDeletion(req(), ctx({ exportRow: makeExport({ export_month: "2026-05" }) })),
    ),
    /month mismatch/,
  );
});

test("refuses: a delivered (state='sent') export — 'already delivered'", () => {
  assert.match(
    refuseCode(planExportDeletion(req(), ctx({ deliveries: [{ state: "sent" }] }))),
    /state 'sent' — already delivered/,
  );
});

test("refuses: a pending delivery — 'may have been delivered' (not 'already delivered')", () => {
  const reason = refuseCode(
    planExportDeletion(req(), ctx({ deliveries: [{ state: "pending" }] })),
  );
  assert.match(reason, /may have been delivered/);
  assert.doesNotMatch(reason, /already delivered/, "pending is not 'already delivered' — the evidence is in-flight, not certain");
});

test("refuses: an ambiguous delivery — 'may have been delivered' (not 'already delivered')", () => {
  const reason = refuseCode(
    planExportDeletion(req(), ctx({ deliveries: [{ state: "ambiguous" }] })),
  );
  assert.match(reason, /may have been delivered/);
  assert.doesNotMatch(reason, /already delivered/);
});

test("refuses: mixed ambiguous + sent reports the definitive 'already delivered' (the worst state wins the message)", () => {
  assert.match(
    refuseCode(
      planExportDeletion(req(), ctx({ deliveries: [{ state: "ambiguous" }, { state: "sent" }] })),
    ),
    /already delivered/,
  );
});

// ─── Sanctioned cases ─────────────────────────────────────────────────────────

test("sanctions: never-delivered finalized export with an explicit exception → plan with all 10 R2 keys + audit", () => {
  const r = planExportDeletion(req(), ctx());
  assert.equal(r.ok, true);
  if (!r.ok) return; // narrowing
  // 3 stored (archive/manifest/proofs) + 7 derived (summary/attendees/readme/amex+cash+digital recon/proofs-noreceipts)
  assert.equal(r.plan.r2Objects.length, 10, "every export artifact key is enumerated for removal");
  assert.ok(r.plan.r2Objects.includes(`exports/${MONTH}/${ID}-receipts.csv`));
  assert.ok(r.plan.r2Objects.includes(`exports/${MONTH}/${ID}-proofs.zip`));
  assert.ok(r.plan.r2Objects.includes(`exports/${MONTH}/${ID}-amex-reconciliation.csv`));

  assert.equal(r.plan.audit.action, "export.deleted");
  assert.equal(r.plan.audit.objectType, "export");
  assert.equal(r.plan.audit.objectId, ID);
  const payload = JSON.parse(r.plan.audit.newValueJson);
  assert.equal(payload.retention_legalhold_exception, req().legalHoldException);
  assert.equal(payload.reason, req().legalHoldException);
  assert.equal(payload.exportId, ID);
  assert.deepEqual(payload.removedR2Objects, r.plan.r2Objects);
});

test("sanctions: a failed delivery (never landed) is deletable", () => {
  const r = planExportDeletion(req(), ctx({ deliveries: [{ state: "failed" }] }));
  assert.equal(r.ok, true, "a failed send does not make the seal delivered");
});

test("sanctions: proofs absent (sealed before proofs shipped) → 9 keys, no proofs.zip", () => {
  const r = planExportDeletion(req(), ctx({ exportRow: makeExport({ proofs_r2_key: null }) }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.plan.r2Objects.length, 9);
  assert.ok(!r.plan.r2Objects.some((k) => k.endsWith("-proofs.zip")));
});
