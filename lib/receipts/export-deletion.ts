import type { ReceiptExport } from "@/lib/receipts/types";
import {
  buildAmexReconciliationKey,
  buildAttendeesKey,
  buildCashReconciliationKey,
  buildDigitalReconciliationKey,
  buildProofsNoReceiptsKey,
  buildReadmeKey,
  buildSummaryKey,
} from "@/lib/receipts/export";

// Backlog #26: the single sanctioned planner for deleting a sealed export. PURE
// (no D1/R2) so the refusal paths are unit-testable without bindings. The
// committed script (scripts/delete-sealed-export.ts) fetches the export + its
// delivery rows, calls this, and executes the plan ONLY in --write with an
// explicit confirmation.
//
// Why this exists: sealing locks edits, but deletion is the one hole in that
// guarantee, and until now it had no code-review surface at all — 2026-06 revs 1
// & 2 were removed on 2026-07-22 by an out-of-band operation recorded with
// non-union audit actions (`export.test_seal_removed`), and no committed code
// deletes receipt_exports (only the 0017 FK cascade, never reached from app
// code). This module is that surface: every refusal is here, and tested.

export interface ExportDeletionRequest {
  exportId: string;
  month: string;
  /** Required, non-empty legal-hold exception, recorded verbatim in the audit.
   *  `receipt_exports.legal_hold` defaults to 1, so deleting a row is ALWAYS a
   *  retention exception — the operator must say why, in their own words. */
  legalHoldException: string;
}

export interface ExportDeletionContext {
  /** The receipt_exports row for exportId (null ⇒ not found). */
  exportRow: ReceiptExport | null;
  /** The export_deliveries rows for the export (the `state` column is all that's
   *  read here). */
  deliveries: { state: string }[];
}

export interface ExportDeletionPlan {
  /** Every R2 object the deletion would remove: the 3 sealed keys stored on the
   *  row (archive/manifest/proofs — authoritative) plus the 7 derived keys that
   *  have no column. The script probes each (some are conditional — recon CSVs
   *  ship only when the month has those rows) and tolerates absence. */
  r2Objects: string[];
  /** The audit entry to write. `actor` is added by the script (it is the one
   *  that knows the operator identity). The legal-hold exception is recorded
   *  verbatim so the retention exception is auditable. */
  audit: {
    action: "export.deleted";
    objectType: "export";
    objectId: string;
    newValueJson: string;
  };
}

export type ExportDeletionResult =
  | { ok: true; plan: ExportDeletionPlan }
  | { ok: false; reason: string };

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/**
 * Plan (or refuse) the deletion of one sealed export. PURE.
 *
 * Refuses when:
 *   - exportId is missing or wildcarded (no "all drafts", no patterns — exact id);
 *   - month is missing, malformed, or wildcarded;
 *   - the legal-hold exception is empty (legal_hold defaults to 1, so deleting
 *     is always a retention exception — the operator must state it);
 *   - the row is not found, or its id/month don't match the request;
 *   - any delivery row is state `'sent'` (a delivered month's seal is not
 *     deletable by this tool at all — a different authorization).
 *
 * `pending`/`ambiguous` deliveries are NOT refused here (the literal gate is the
 * delivered state, `'sent'`). They mean a send may or may not have landed; the
 * script can additionally refuse them — see delivery-state.ts
 * MAY_HAVE_REACHED_RECIPIENT_STATES.
 */
export function planExportDeletion(
  req: ExportDeletionRequest,
  ctx: ExportDeletionContext,
): ExportDeletionResult {
  const exportId = req.exportId.trim();
  if (!exportId) {
    return refuse("export id is required — exact id, no wildcards, no 'all drafts'");
  }
  if (/[*%]/.test(exportId)) {
    return refuse("wildcards are not allowed in the export id");
  }
  if (!/^\d{4}-\d{2}$/.test(req.month)) {
    return refuse("month is required as YYYY-MM (exact, no wildcards)");
  }
  if (/[*%]/.test(req.month)) {
    return refuse("wildcards are not allowed in the month");
  }
  const exception = req.legalHoldException.trim();
  if (!exception) {
    return refuse(
      "an explicit legal-hold exception string is required (legal_hold defaults to 1; deleting a sealed export is always a retention exception) — recorded verbatim in the audit",
    );
  }

  const row = ctx.exportRow;
  if (!row) {
    return refuse(`no receipt_exports row found for id ${exportId}`);
  }
  if (row.id !== exportId) {
    return refuse(`id mismatch: requested ${exportId}, row id is ${row.id}`);
  }
  if (row.export_month !== req.month) {
    return refuse(
      `month mismatch: requested ${req.month}, row export_month is ${row.export_month}`,
    );
  }
  if (ctx.deliveries.some((d) => d.state === "sent")) {
    return refuse(
      `export ${exportId} has a delivery row in state 'sent' (delivered) — a delivered month's seal is not deletable by this tool; that is a different authorization`,
    );
  }

  // Plan: every R2 object to remove (3 stored, authoritative + 7 derived) and
  // the audit payload (exception recorded verbatim).
  const stored = [row.archive_r2_key, row.manifest_r2_key, row.proofs_r2_key].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  const derived = [
    buildSummaryKey(row.export_month, row.id),
    buildAttendeesKey(row.export_month, row.id),
    buildReadmeKey(row.export_month, row.id),
    buildAmexReconciliationKey(row.export_month, row.id),
    buildCashReconciliationKey(row.export_month, row.id),
    buildDigitalReconciliationKey(row.export_month, row.id),
    buildProofsNoReceiptsKey(row.export_month, row.id),
  ];
  const r2Objects = [...stored, ...derived];

  const audit: ExportDeletionPlan["audit"] = {
    action: "export.deleted",
    objectType: "export",
    objectId: row.id,
    newValueJson: JSON.stringify({
      exportId: row.id,
      month: row.export_month,
      exportRevision: row.export_revision ?? 1,
      reason: exception,
      retention_legalhold_exception: exception,
      removedR2Objects: r2Objects,
    }),
  };

  return { ok: true, plan: { r2Objects, audit } };
}
