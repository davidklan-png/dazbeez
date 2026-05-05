import type { AuditAction, ReceiptAuditEntry } from "@/lib/receipts/types";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { nowIso, newUuid } from "@/lib/receipts/db-utils";

export async function createAuditEntry(
  db: D1Database,
  entry: {
    actor: string;
    action: AuditAction;
    objectType: string;
    objectId: string;
    oldValueJson?: string | null;
    newValueJson?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO receipt_audit_log
        (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newUuid(),
      entry.actor,
      entry.action,
      entry.objectType,
      entry.objectId,
      entry.oldValueJson ?? null,
      entry.newValueJson ?? null,
      nowIso(),
    )
    .run();
}

export async function listAuditEntries(
  objectType: string,
  objectId: string,
): Promise<ReceiptAuditEntry[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at
       FROM receipt_audit_log
       WHERE object_type = ? AND object_id = ?
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    .bind(objectType, objectId)
    .all<ReceiptAuditEntry>();
  return result.results ?? [];
}
