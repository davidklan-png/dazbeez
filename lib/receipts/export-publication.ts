// One-transaction publication for export bundles (seal boundary, migration
// 0042 + contract §E). Both modes — draft rebuild and one-shot finalize —
// stage every artifact into the attempt's private R2 namespace FIRST, then
// commit ALL durable state in a single D1 batch:
//
//   1. replace receipt_export_items for the export (staged in this transaction
//      only — the pre-claim published set survives a failed attempt);
//   2. UPDATE the exact draft row with all candidate metadata + bundle_build_id
//      (+ finalized fields), clearing the claim in the SAME statement. The
//      WHERE requires status='draft', the matching token, and an UNEXPIRED
//      lease — an expired or losing attempt changes 0 rows;
//   3. IMMEDIATELY insert the export.generated / export.finalized audit with
//      actor = CASE WHEN changes()=1 THEN ? ELSE NULL END. receipt_audit_log.
//      actor is NOT NULL, so a lost CAS raises a constraint error INSIDE the
//      batch and rolls back items + every candidate field. (This is the
//      changes()=0-after-batch hole: a zero-row UPDATE is not a statement
//      failure, so the assertion must be a SQL constraint, not a JS check.)
//      Do not put any statement between (2) and (3), and never INSERT OR
//      IGNORE here — that would swallow exactly the assertion we rely on.
//   4. Finalize only: promote eligible receipts from the published item set
//      and write their lifecycle audits in the SAME batch. The promotion runs
//      after (2) cleared the claim in-transaction, so the claim guard does not
//      fire on it; the post-seal guard admits it because the export is already
//      'finalized' with the item rows present (the trigger's justification
//      subquery sees this transaction's writes).
//
// All candidate values (keys, SHAs, message override, payment-due date) are
// assembled in memory while objects upload; nothing touches the export row
// before this batch. On any failure the previously published draft metadata/
// items still point at the previous complete build.

import { newUuid, stringifyJson } from "@/lib/receipts/db-utils";

/**
 * The publication CAS lost: the draft row was sealed, claimed by a successor,
 * or its lease expired between staging and commit — the batch rolled back and
 * NOTHING was published. Typed here (not at the route) so every caller maps
 * it to a conflict instead of surfacing the driver's raw NOT NULL text.
 */
export class PublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationConflictError";
  }
}

/**
 * The assertion's specific driver signature. Matched ONLY against this one
 * constraint — our changes()=1 gate on the export audit — so unrelated SQL
 * failures (their own NOT NULLs, syntax, constraints) stay real errors.
 */
const CAS_ASSERTION_PATTERN =
  /NOT NULL constraint failed:?\s*receipt_audit_log\.actor/i;

export interface PublishExportCandidateInput {
  exportId: string;
  /** The statement month being built. */
  month: string;
  /** The attempt's claim token — doubles as the published bundle_build_id. */
  buildId: string;
  actor: string;
  /** finalize=false publishes a draft rebuild; finalize=true seals. */
  finalize: boolean;
  rowCount: number;
  archiveKey: string;
  manifestKey: string;
  archiveSha256: string;
  manifestSha256: string | null;
  proofsKey: string;
  proofsSha256: string;
  /** Payment-due date snapshot (0035) from the protected artifact read. */
  paymentDueDate: string | null;
  /**
   * The message VALUE to publish: on finalize the explicit decision value; on
   * rebuild either the stored value (no override supplied) or the resolved
   * override. Publishing never writes operator_message_updated_at — the
   * decision timestamp moves only with an explicit decision.
   */
  operatorMessage: string | null;
  /** Staged item set (receipts + amex lines) for this build. */
  items: Array<{ itemType: "receipt" | "amex_line"; itemId: string }>;
  /**
   * Finalize only: bundle receipts whose status is pre-export — exactly the
   * set the promotion will hit. The claim froze receipt writes, so the
   * in-memory statuses are still the committed ones at publication time.
   */
  promotableReceiptIds: string[];
}

export interface PublishExportResult {
  published: true;
  finalized: boolean;
}

/** Statuses the exporter promotes; mirrored from the promotion UPDATE. */
const PRE_EXPORT_STATUSES = "('captured','needs_review','reviewed','reconciled')";

export async function publishExportBundle(
  db: D1Database,
  c: PublishExportCandidateInput,
): Promise<PublishExportResult> {
  const now = new Date().toISOString();
  const finalizationHash = c.manifestSha256 ?? c.archiveSha256;

  const stmts: D1PreparedStatement[] = [];

  // (1) Replace the item set — staged within this transaction only.
  stmts.push(
    db.prepare(`DELETE FROM receipt_export_items WHERE export_id = ?`).bind(c.exportId),
  );
  for (const it of c.items) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO receipt_export_items
            (id, export_id, item_type, item_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(newUuid(), c.exportId, it.itemType, it.itemId, now),
    );
  }

  // (2) The publication CAS: all candidate metadata + build id, finalize
  // fields when sealing, claim cleared — all in one statement, admitted only
  // while THIS attempt's lease is live on a still-draft row.
  const finalizeSets = c.finalize
    ? `, status = 'finalized',
           finalization_hash = ?,
           finalized_by = ?,
           finalized_at = ?`
    : "";
  const finalizeBinds = c.finalize ? [finalizationHash, c.actor, now] : [];
  stmts.push(
    db
      .prepare(
        `UPDATE receipt_exports
           SET archive_r2_key = ?,
               manifest_r2_key = ?,
               archive_sha256 = ?,
               manifest_sha256 = ?,
               proofs_r2_key = ?,
               proofs_sha256 = ?,
               bundle_built_at = ?,
               payment_due_date = ?,
               operator_message = ?,
               bundle_build_id = ?,
               sealing_token = NULL,
               sealing_expires_at = NULL${finalizeSets}
         WHERE id = ?
           AND status = 'draft'
           AND sealing_token = ?
           AND sealing_expires_at IS NOT NULL
           AND sealing_expires_at > CAST(strftime('%s','now') AS INTEGER)`,
      )
      .bind(
        c.archiveKey,
        c.manifestKey,
        c.archiveSha256,
        c.manifestSha256 ?? null,
        c.proofsKey,
        c.proofsSha256,
        now,
        c.paymentDueDate ?? null,
        c.operatorMessage ?? null,
        c.buildId,
        ...finalizeBinds,
        c.exportId,
        c.buildId,
      ),
  );

  // (3) Audit assertion — see the header comment. changes() reflects statement
  // (2) and nothing else; a NULL actor is a NOT NULL violation that rolls the
  // whole batch (items + metadata + seal fields) back.
  stmts.push(
    db
      .prepare(
        `INSERT INTO receipt_audit_log
          (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
         VALUES (?, CASE WHEN changes() = 1 THEN ? ELSE NULL END, ?, 'export', ?, NULL, ?, ?)`,
      )
      .bind(
        newUuid(),
        c.actor,
        c.finalize ? "export.finalized" : "export.generated",
        c.exportId,
        stringifyJson({
          archiveKey: c.archiveKey,
          sha256: c.archiveSha256,
          manifestSha256: c.manifestSha256 ?? null,
          proofsR2Key: c.proofsKey,
          proofsSha256: c.proofsSha256,
          bundleBuildId: c.buildId,
          rowCount: c.rowCount,
        }),
        now,
      ),
  );

  // (4) Finalize only: promotion + lifecycle audits from the PUBLISHED item
  // set, inside this same batch. Set-based over the items this transaction
  // just staged; already-exported/archived rows are skipped by the status
  // guard, preserving today's behavior.
  if (c.finalize) {
    stmts.push(
      db
        .prepare(
          `UPDATE receipt_records
             SET status = 'exported',
                 exported_month = ?,
                 updated_at = ?
           WHERE id IN (
             SELECT item_id FROM receipt_export_items
             WHERE export_id = ? AND item_type = 'receipt'
           )
             AND status IN ${PRE_EXPORT_STATUSES}`,
        )
        .bind(c.month, now, c.exportId),
    );
    for (const receiptId of c.promotableReceiptIds) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO receipt_audit_log
              (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
             VALUES (?, ?, 'receipt.exported', 'receipt', ?, NULL, ?, ?)`,
          )
          .bind(
            newUuid(),
            c.actor,
            receiptId,
            stringifyJson({ exportId: c.exportId, exportedMonth: c.month }),
            now,
          ),
      );
    }
  }

  try {
    await db.batch(stmts);
  } catch (err) {
    // A zero-row CAS turns the audit INSERT's CASE expression into a NULL
    // actor — the NOT NULL violation we rely on to roll the batch back. Map
    // exactly that signature to the typed conflict; anything else is a real
    // error and must keep propagating untouched.
    if (err instanceof Error && CAS_ASSERTION_PATTERN.test(err.message)) {
      throw new PublicationConflictError(
        "The bundle could not be published — this export was sealed, re-claimed, or its build lease expired while staging. Nothing was published; reload the export page and retry.",
      );
    }
    throw err;
  }
  return { published: true, finalized: c.finalize };
}
