import { nowIso, newUuid, stringifyJson } from "@/lib/receipts/db-utils";
import { parseRenderFailedBody } from "@/lib/receipts/render-recovery";

export function parseExtractionFailedBody(raw: unknown):
  | { ok: true; reason: string; model: string | null }
  | { ok: false; status: 400 | 413; error: string } {
  // The reason boundary is identical for both permanent-failure reporters.
  const parsed = parseRenderFailedBody(raw);
  if (!parsed.ok) return parsed;
  const model = (raw as { model?: unknown }).model;
  if (model != null && typeof model !== "string") {
    return { ok: false, status: 400, error: "`model` must be a string or null." };
  }
  return { ...parsed, model: model?.trim() || null };
}

interface FailureRow {
  deleted_at: string | null;
  needs_render: number | null;
  status: string;
  extraction_state: string | null;
  extraction_json: string | null;
}

export type ExtractionFailureResult =
  | { kind: "recorded"; failedAt: string }
  | { kind: "already_terminal"; reason: string | null; failedAt: string | null }
  | { kind: "processed" }
  | { kind: "refused" }
  | { kind: "not_found" };

/** Commit the admitted failure, current JSON patch and winning audit together. */
export async function recordExtractionFailure(input: {
  db: D1Database;
  receiptId: string;
  reason: string;
  model: string | null;
  actor: string;
  now?: string;
}): Promise<ExtractionFailureResult> {
  const { db, receiptId, reason, model, actor } = input;
  const now = input.now ?? nowIso();
  const results = await db.batch([
    db.prepare(
      `UPDATE receipt_records
          SET extraction_state = 'failed', extraction_processed_at = ?,
              extraction_json = json_patch(
                CASE WHEN json_valid(extraction_json) THEN
                  CASE WHEN json_type(extraction_json) = 'object' THEN extraction_json ELSE '{}' END
                ELSE '{}' END, ?),
              updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
          AND (needs_render = 0 OR needs_render IS NULL)
          AND status IN ('captured','needs_review')
          AND (extraction_state IN ('captured','queued','processing') OR extraction_state IS NULL)`,
    ).bind(now, stringifyJson({ failed: true, reason, model, failedAt: now }), now, receiptId),
    // changes() belongs to the immediately preceding UPDATE in this batch.
    db.prepare(
      `INSERT INTO receipt_audit_log
         (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
       SELECT ?, ?, 'receipt.extraction_failed', 'receipt', ?, NULL, ?, ?
       WHERE changes() = 1`,
    ).bind(newUuid(), actor, receiptId, stringifyJson({ failureReason: reason, model }), now),
  ]);
  const changed = results[0]?.meta.changes;
  if (results.length !== 2 || results.some((r) => !r.success) ||
      (changed !== 0 && changed !== 1) || results[1]?.meta.changes !== changed) {
    throw new Error("Unconfirmed extraction-failure batch outcome.");
  }
  if (changed === 1) return { kind: "recorded", failedAt: now };

  const read = () => db.prepare(
    `SELECT deleted_at, needs_render, status, extraction_state, extraction_json
       FROM receipt_records WHERE id = ?`,
  ).bind(receiptId).first<FailureRow>();
  let row = await read();
  if (!row || row.deleted_at) return { kind: "not_found" };

  // A human-advanced extraction row can heal stale pending queue state, but
  // wrong-pipeline/deleted rows and committed terminal outcomes stay untouched.
  if ((row.needs_render === 0 || row.needs_render === null) &&
      row.status !== "captured" && row.status !== "needs_review") {
    await db.prepare(
      `UPDATE receipt_records
          SET extraction_state = 'processed', extraction_processed_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
          AND (needs_render = 0 OR needs_render IS NULL)
          AND status NOT IN ('captured','needs_review')
          AND (extraction_state IN ('captured','queued','processing') OR extraction_state IS NULL)`,
    ).bind(now, now, receiptId).run();
    row = await read();
  }
  if (!row || row.deleted_at) return { kind: "not_found" };
  if (row.needs_render !== 0 && row.needs_render !== null) return { kind: "refused" };
  if (row.extraction_state === "processed") return { kind: "processed" };
  if (row.extraction_state === "failed") {
    let marker: { reason?: unknown; failedAt?: unknown } | null = null;
    try { marker = JSON.parse(row.extraction_json ?? "null"); } catch { /* Legacy malformed JSON. */ }
    return {
      kind: "already_terminal",
      reason: typeof marker?.reason === "string" ? marker.reason : null,
      failedAt: typeof marker?.failedAt === "string" ? marker.failedAt : null,
    };
  }
  return { kind: "refused" };
}
