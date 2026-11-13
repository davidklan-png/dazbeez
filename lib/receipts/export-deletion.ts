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
import {
  ATTEMPT_STATE,
  MAY_HAVE_REACHED_RECIPIENT_STATES,
} from "@/lib/receipts/delivery-state";

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
  /** Wall-clock seconds, injected by the script (Date.now()/1000). Used ONLY
   *  for the active-build-claim refusal — the D1-side CAS remains the real
   *  authority; this precheck just gives the operator a readable refusal. */
  nowEpochSeconds?: number;
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
 *   - any delivery row is in a state where the pack MAY have reached the
 *     accountant — `MAY_HAVE_REACHED_RECIPIENT_STATES` from delivery-state.ts
 *     (`sent` / `pending` / `ambiguous`). Only a definitively `failed` delivery
 *     (never accepted ⇒ nothing was delivered ⇒ nothing to destroy) permits
 *     deletion. This is the same doctrine #171 used to require an explicit
 *     confirmation before SENDING a second pack; it applies more forcefully to
 *     DELETING a sealed export — if the pack may have reached the accountant,
 *     deleting destroys the only record of what they were sent. The refusal
 *     message distinguishes `sent` ("already delivered") from `pending`/
 *     `ambiguous` ("may have been delivered") so the operator is never told a
 *     pack was delivered when the evidence is ambiguous.
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
  // Seal boundary (0042): refuse while a build claim is ACTIVE on this row —
  // a draft under construction may be staging objects right now; deleting the
  // row (and cascading its items) under a live builder breaks the boundary the
  // claim exists to draw. Expiry (or the builder's release) re-enables.
  const claimActive =
    !!row.sealing_token &&
    typeof row.sealing_expires_at === "number" &&
    row.sealing_expires_at > (ctx.nowEpochSeconds ?? 0);
  if (claimActive) {
    return refuse(
      `export ${exportId} holds an active build claim (sealing_token present, lease unexpired) — a build is in progress. Retry after it publishes, releases, or its lease expires.`,
    );
  }

  // Refuse if any delivery may have reached the accountant. Reuse the named
  // constant from delivery-state.ts (the doctrine #171 settled) rather than
  // re-spelling the set. Only a definitively 'failed' delivery permits deletion.
  const reaching = ctx.deliveries.filter((d) =>
    (MAY_HAVE_REACHED_RECIPIENT_STATES as readonly string[]).includes(d.state),
  );
  if (reaching.length > 0) {
    if (reaching.some((d) => d.state === ATTEMPT_STATE.SENT)) {
      return refuse(
        `export ${exportId} has a delivery row in state 'sent' — already delivered. A delivered month's seal is not deletable by this tool; that is a different authorization.`,
      );
    }
    const states = [...new Set(reaching.map((d) => d.state))].sort().join("/");
    return refuse(
      `export ${exportId} has a delivery row in state '${states}' — may have been delivered (a send is in flight or its outcome is unknown). Not deletable: if the pack reached the accountant, deleting destroys the only record of what they were sent.`,
    );
  }

  // Plan: every R2 object to remove (3 stored, authoritative + 7 derived) and
  // the audit payload (exception recorded verbatim).
  const stored = [row.archive_r2_key, row.manifest_r2_key, row.proofs_r2_key].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  // Derived keys resolve under the row's PUBLISHED build namespace when it has
  // one (0042); NULL keeps the legacy export-ID paths for rows sealed before it.
  // Sealed objects never move, so this stays stable for the row's lifetime.
  const buildId = row.bundle_build_id ?? null;
  const derived = [
    buildSummaryKey(row.export_month, row.id, buildId),
    buildAttendeesKey(row.export_month, row.id, buildId),
    buildReadmeKey(row.export_month, row.id, buildId),
    buildAmexReconciliationKey(row.export_month, row.id, buildId),
    buildCashReconciliationKey(row.export_month, row.id, buildId),
    buildDigitalReconciliationKey(row.export_month, row.id, buildId),
    buildProofsNoReceiptsKey(row.export_month, row.id, buildId),
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

// ─── Transactional execution (seal boundary B8) ──────────────────────────────
//
// The ONLY admitted way to delete an export row: ONE D1 transaction that
// writes the typed `export.deleted` audit marker FIRST (gated on the planned
// identity AND the absence of a live build claim), then removes deliveries,
// item rows, and the export row. The 0042 guards make the marker the CAS:
// without it, the finalized-items delete and the sealed-parent delete are
// refused, so a claim acquired after planning (or any identity drift) aborts
// the WHOLE transaction — deliveries and items roll back with the marker.
// R2 objects may be removed only AFTER this transaction is confirmed; on any
// uncertain outcome they are retained.

export interface ExportDeletionExecutionInput {
  exportId: string;
  month: string;
  /** The row's status as observed at plan time — re-checked transactionally. */
  plannedStatus: string;
  actor: string;
  nowIso: string;
  /** Fresh audit-row id (caller-generated). */
  auditId: string;
  /** The planner's audit payload (legal-hold exception recorded verbatim). */
  auditValueJson: string;
}

export interface ExportDeletionExecutionResult {
  /** 1 when the export row was deleted under the planned identity; else 0. */
  exportRowsDeleted: number;
  /** Whether the authorization marker was written (identity + claim held). */
  markerWritten: boolean;
}

/**
 * The deletion transaction's statements, in execution order. PURE — the
 * committed script renders them as literals for `wrangler d1 execute --file`,
 * and tests execute them against real SQLite with the 0042 triggers live.
 */
export function buildExportDeletionStatements(
  input: ExportDeletionExecutionInput,
): Array<{ sql: string; args: unknown[] }> {
  return [
    {
      // Authorization marker + transactional CAS: inserts only when the row
      // still matches the planned identity and holds no unexpired claim.
      sql: `INSERT INTO receipt_audit_log
              (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
            SELECT ?, ?, 'export.deleted', 'export', e.id, NULL, ?, ?
              FROM receipt_exports e
             WHERE e.id = ? AND e.export_month = ? AND e.status = ?
               AND (e.sealing_token IS NULL OR e.sealing_expires_at IS NULL
                    OR e.sealing_expires_at <= CAST(strftime('%s','now') AS INTEGER))`,
      args: [
        input.auditId,
        input.actor,
        input.auditValueJson,
        input.nowIso,
        input.exportId,
        input.month,
        input.plannedStatus,
      ],
    },
    {
      sql: `DELETE FROM export_deliveries WHERE export_id = ?`,
      args: [input.exportId],
    },
    {
      // Admitted only by the marker (0042 seal_items_delete); for a draft
      // parent the guard is inactive by design.
      sql: `DELETE FROM receipt_export_items WHERE export_id = ?`,
      args: [input.exportId],
    },
    {
      // Claim-active and sealed-without-marker guards both apply here.
      sql: `DELETE FROM receipt_exports WHERE id = ?`,
      args: [input.exportId],
    },
  ];
}

/**
 * Execute the deletion transaction against D1 (one batch). Throws on any
 * statement failure — including the 0042 guard aborts when the marker did not
 * authorize the deletion — leaving every row (and the marker) rolled back.
 * The caller treats `exportRowsDeleted !== 1` as a refusal and RETAINS all
 * R2 objects.
 */
export async function executeExportDeletion(
  db: D1Database,
  input: ExportDeletionExecutionInput,
): Promise<ExportDeletionExecutionResult> {
  const stmts = buildExportDeletionStatements(input);
  const results = await db.batch(
    stmts.map((st) => db.prepare(st.sql).bind(...st.args)),
  );
  const markerWritten = (results[0]?.meta.changes ?? 0) === 1;
  const exportRowsDeleted = results[3]?.meta.changes ?? 0;
  if (!markerWritten && exportRowsDeleted === 1) {
    // Marker skipped (identity/claim drift) yet the row deleted anyway — only
    // reachable for a draft whose row vanished mid-transaction elsewhere.
    // Treat as NOT confirmed; the caller retains objects.
    return { exportRowsDeleted: 0, markerWritten };
  }
  return { exportRowsDeleted, markerWritten };
}
