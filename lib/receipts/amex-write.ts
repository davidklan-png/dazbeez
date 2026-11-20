import { newUuid, nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import type { AuditAction } from "@/lib/receipts/types";

export type AmexWriteCode =
  | "amex_line_sealed" | "amex_line_build_conflict"
  | "amex_line_missing" | "amex_line_revision_conflict"
  | "amex_trip_missing" | "amex_trip_revision_conflict"
  | "amex_trip_members_conflict" | "amex_trip_ownership_conflict"
  | "amex_receipt_missing" | "amex_receipt_ineligible" | "amex_receipt_revision_conflict";

export class AmexWriteError extends Error {
  constructor(public code: AmexWriteCode, public status = code.endsWith("_missing") ? 404 : 409) {
    super(code === "amex_line_sealed" ? "This reconciliation is finalized — unseal to edit." : code === "amex_line_build_conflict" ? "This month has an active export build — reload to review." : code.endsWith("_missing")
      ? "This item was removed. Reload to review; your edits are kept on this form."
      : "This AMEX line or trip changed. Reload to review; your edits are kept on this form.");
  }
}

export function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function revisionInputError(value: unknown): { code: string; error: string } | null {
  if (validRevision(value)) return null;
  return {
    code: value === undefined ? "expected_revision_required" : "expected_revision_invalid",
    error: "A nonnegative safe-integer expectedRevision is required. Reload to review before saving.",
  };
}

export function amexAssertion(db: D1Database, code: AmexWriteCode, condition: string, binds: unknown[]): D1PreparedStatement {
  return db.prepare(`INSERT INTO amex_write_assertions(failure) SELECT ? WHERE NOT (${condition})`)
    .bind(code, ...binds);
}

export function admitAmexLine(db: D1Database, id: string, revision: number): D1PreparedStatement[] {
  if (!validRevision(revision)) throw new Error("Invalid expectedRevision");
  return [
    amexAssertion(db, "amex_line_missing", "EXISTS (SELECT 1 FROM amex_statement_lines WHERE id = ?)", [id]),
    amexAssertion(db, "amex_line_revision_conflict", "EXISTS (SELECT 1 FROM amex_line_revisions WHERE line_id = ? AND revision = ?)", [id, revision]),
  ];
}

export function amexAudit(db: D1Database, actor: string, action: AuditAction, objectType: string, id: string, value: unknown, oldValue?: unknown): D1PreparedStatement {
  return db.prepare(`INSERT INTO receipt_audit_log
    (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newUuid(), actor, action, objectType, id, oldValue === undefined ? null : stringifyJson(oldValue), stringifyJson(value), nowIso());
}

export async function amexBatch<T>(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
  try {
    return await db.batch<T>(statements);
  } catch (error) {
    const match = error instanceof Error && error.message.match(/CHECK constraint failed:\s*(amex_(?:line|trip|receipt)_\w+)/);
    if (match) throw new AmexWriteError(match[1] as AmexWriteCode);
    throw error;
  }
}

export function lineRevisionSelect(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare(`SELECT revision,
    (SELECT json_group_object(id, revision) FROM business_trip_reports WHERE id IN (
      SELECT business_trip_id FROM amex_statement_lines WHERE id = ?
      UNION SELECT business_trip_report_id FROM business_trip_report_lines WHERE amex_statement_line_id = ?)) AS trip_revisions_json,
    (SELECT json_group_object(id, revision) FROM receipt_records WHERE id IN (
      SELECT matched_receipt_id FROM amex_statement_lines WHERE id = ?)) AS receipt_revisions_json
    FROM amex_line_revisions WHERE line_id = ?`).bind(id, id, id, id);
}

export function tripExpectation(body: { expectedRevision?: unknown; expectedLines?: unknown }, requireLines: boolean) {
  const error = revisionInputError(body.expectedRevision);
  if (error) return { error };
  const lines = body.expectedLines;
  if ((requireLines || lines !== undefined) &&
    (typeof lines !== "object" || lines === null || Array.isArray(lines) || !Object.values(lines).every(validRevision))) {
    return { error: { code: "expected_lines_invalid", error: "Loaded expectedLines revisions are required. Reload to review." } };
  }
  return { expected: { expectedRevision: body.expectedRevision as number, expectedLines: (lines ?? {}) as Record<string, number> } };
}

export function revisionMap(value: unknown): value is Record<string, number> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(validRevision);
}
