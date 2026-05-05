import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, newUuid, stringifyJson } from "@/lib/receipts/db-utils";
import type {
  AmexMatchStatus,
  AmexStatementLine,
  AmexStatementArtifact,
  BusinessTripReport,
  BusinessTripCandidate,
  CreateAmexArtifactInput,
  CreateAttendeeInput,
  CreateReceiptInput,
  DashboardAlertDismissal,
  ImportAmexLineInput,
  MissingStatementAlert,
  ReceiptAttendee,
  ReceiptExport,
  ReceiptRecord,
  UpdateAmexLineCategoryInput,
  UpdateReceiptInput,
} from "@/lib/receipts/types";

// ─── Receipt records ─────────────────────────────────────────────────────────

export async function createReceiptRecord(
  input: CreateReceiptInput,
  actor: string,
): Promise<string> {
  const db = getReceiptsDb();
  const id = newUuid();
  const now = nowIso();

  const paymentPath = input.paymentPath ?? "UNKNOWN";
  const expenseType = input.expenseType ?? "UNKNOWN";

  await db
    .prepare(
      `INSERT INTO receipt_records
        (id, captured_at, captured_by, source, original_filename,
         payment_path, expense_type,
         transaction_date, merchant, amount_minor, currency, tax_amount_minor,
         business_purpose, alcohol_present, attendees_required, status,
         original_r2_key, original_sha256, original_content_type, original_size_bytes,
         legacy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      id,
      now,
      input.capturedBy,
      input.source ?? "upload",
      input.originalFilename ?? null,
      paymentPath,
      expenseType,
      input.transactionDate ?? null,
      input.merchant ?? null,
      input.amountMinor ?? null,
      input.currency ?? "JPY",
      input.taxAmountMinor ?? null,
      input.businessPurpose ?? null,
      input.alcoholPresent ? 1 : 0,
      expenseType === "meeting-no-alcohol" ||
      expenseType === "entertainment-alcohol"
        ? 1
        : 0,
      "needs_review",
      input.originalR2Key,
      input.originalSha256,
      input.originalContentType,
      input.originalSizeBytes,
      now,
      now,
    )
    .run();

  await createAuditEntry(db, {
    actor,
    action: "receipt.uploaded",
    objectType: "receipt",
    objectId: id,
    newValueJson: stringifyJson({ paymentPath, expenseType, source: input.source ?? "upload" }),
  });

  return id;
}

export async function getReceiptRecord(
  id: string,
): Promise<ReceiptRecord | null> {
  const db = getReceiptsDb();
  return db
    .prepare(`SELECT * FROM receipt_records WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ReceiptRecord>();
}

export async function updateReceiptRecord(
  id: string,
  input: UpdateReceiptInput,
  actor: string,
): Promise<void> {
  const db = getReceiptsDb();

  const before = await db
    .prepare(`SELECT * FROM receipt_records WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ReceiptRecord>();

  if (!before) throw new Error(`Receipt ${id} not found.`);

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (input.paymentPath !== undefined) { sets.push("payment_path = ?"); binds.push(input.paymentPath); }
  if (input.expenseType !== undefined) { sets.push("expense_type = ?"); binds.push(input.expenseType); }
  if ("transactionDate" in input) { sets.push("transaction_date = ?"); binds.push(input.transactionDate ?? null); }
  if ("merchant" in input) { sets.push("merchant = ?"); binds.push(input.merchant ?? null); }
  if ("amountMinor" in input) { sets.push("amount_minor = ?"); binds.push(input.amountMinor ?? null); }
  if (input.currency !== undefined) { sets.push("currency = ?"); binds.push(input.currency); }
  if ("taxAmountMinor" in input) { sets.push("tax_amount_minor = ?"); binds.push(input.taxAmountMinor ?? null); }
  if ("businessPurpose" in input) { sets.push("business_purpose = ?"); binds.push(input.businessPurpose ?? null); }
  if (input.alcoholPresent !== undefined) { sets.push("alcohol_present = ?"); binds.push(input.alcoholPresent ? 1 : 0); }
  if (input.status !== undefined) { sets.push("status = ?"); binds.push(input.status); }
  if ("processedR2Key" in input) { sets.push("processed_r2_key = ?"); binds.push(input.processedR2Key ?? null); }
  if ("extractionJson" in input) { sets.push("extraction_json = ?"); binds.push(input.extractionJson ?? null); }
  if ("exportedMonth" in input) { sets.push("exported_month = ?"); binds.push(input.exportedMonth ?? null); }
  if ("expenseCategoryCode" in input) { sets.push("expense_category_code = ?"); binds.push(input.expenseCategoryCode ?? null); }

  if (sets.length === 0) return;

  sets.push("updated_at = ?");
  binds.push(nowIso());
  binds.push(id);

  await db
    .prepare(`UPDATE receipt_records SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "receipt.updated",
    objectType: "receipt",
    objectId: id,
    oldValueJson: stringifyJson(before),
    newValueJson: stringifyJson(input),
  });
}

export interface ListReceiptsFilter {
  status?: string;
  month?: string;
  paymentPath?: string;
  limit?: number;
  offset?: number;
}

export async function listReceiptRecords(
  filter?: ListReceiptsFilter,
): Promise<ReceiptRecord[]> {
  const db = getReceiptsDb();
  const conditions: string[] = ["deleted_at IS NULL"];
  const binds: unknown[] = [];

  if (filter?.status) {
    conditions.push("status = ?");
    binds.push(filter.status);
  }
  if (filter?.paymentPath) {
    conditions.push("payment_path = ?");
    binds.push(filter.paymentPath);
  }
  if (filter?.month) {
    conditions.push("transaction_date LIKE ?");
    binds.push(`${filter.month}%`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = filter?.limit ?? 100;
  const offset = filter?.offset ?? 0;
  binds.push(limit, offset);

  const result = await db
    .prepare(
      `SELECT * FROM receipt_records ${where} ORDER BY captured_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds)
    .all<ReceiptRecord>();

  return result.results ?? [];
}

const DELETABLE_STATUSES = new Set(["captured", "needs_review", "reviewed"]);

export async function softDeleteReceipt(
  id: string,
  actor: string,
  reason?: string,
): Promise<void> {
  const db = getReceiptsDb();

  const record = await db
    .prepare(`SELECT id, status FROM receipt_records WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ id: string; status: string }>();

  if (!record) throw new Error(`Receipt ${id} not found.`);

  if (!DELETABLE_STATUSES.has(record.status)) {
    throw new Error(
      `Receipt cannot be deleted because its status is "${record.status}". Only captured, needs_review, and reviewed receipts may be deleted.`,
    );
  }

  const now = nowIso();
  await db
    .prepare(
      `UPDATE receipt_records SET deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(now, actor, reason ?? null, now, id)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "receipt.deleted",
    objectType: "receipt",
    objectId: id,
    newValueJson: stringifyJson({ reason: reason ?? null }),
  });
}

// ─── Attendees ────────────────────────────────────────────────────────────────

export async function createAttendees(
  receiptId: string,
  attendees: CreateAttendeeInput[],
  actor: string,
): Promise<void> {
  if (attendees.length === 0) return;
  const db = getReceiptsDb();
  const now = nowIso();

  // Replace existing attendees for this receipt
  await db.prepare(`DELETE FROM receipt_attendees WHERE receipt_id = ?`).bind(receiptId).run();

  for (const a of attendees) {
    await db
      .prepare(
        `INSERT INTO receipt_attendees
          (id, receipt_id, attendee_name, company, relationship, is_dazbeez_employee, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newUuid(),
        receiptId,
        a.attendeeName,
        a.company ?? null,
        a.relationship ?? null,
        a.isDazbeezEmployee ? 1 : 0,
        a.notes ?? null,
        now,
      )
      .run();
  }

  await createAuditEntry(db, {
    actor,
    action: "receipt.updated",
    objectType: "receipt",
    objectId: receiptId,
    newValueJson: stringifyJson({ attendees: attendees.map((a) => a.attendeeName) }),
  });
}

export async function listAttendees(
  receiptId: string,
): Promise<ReceiptAttendee[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT * FROM receipt_attendees WHERE receipt_id = ? ORDER BY created_at ASC`,
    )
    .bind(receiptId)
    .all<ReceiptAttendee>();
  return result.results ?? [];
}

// ─── AMEX statement lines ─────────────────────────────────────────────────────

export async function importAmexLines(
  rows: ImportAmexLineInput[],
  actor: string,
): Promise<{ imported: number; skipped: number }> {
  const db = getReceiptsDb();
  let imported = 0;
  let skipped = 0;
  const now = nowIso();

  for (const row of rows) {
    const id = newUuid();
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO amex_statement_lines
          (id, statement_month, transaction_date, posting_date, merchant,
           amount_minor, currency, amex_reference, match_status, raw_json,
           statement_artifact_id, cardholder_name, cardholder_flag, payment_type,
           prepayment_flag, memo, raw_csv_line_number, source_file_sha256, imported_at,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        row.statementMonth,
        row.transactionDate,
        row.postingDate ?? null,
        row.merchant,
        row.amountMinor,
        row.currency ?? "JPY",
        row.amexReference ?? null,
        row.rawJson,
        row.statementArtifactId ?? null,
        row.cardholderName ?? null,
        row.cardholderFlag ?? null,
        row.paymentType ?? null,
        row.prepaymentFlag ?? null,
        row.memo ?? null,
        row.rawCsvLineNumber ?? null,
        row.sourceFileSha256 ?? null,
        now,
        now,
      )
      .run();

    if ((result.meta.changes ?? 0) > 0) {
      imported++;
    } else {
      skipped++;
    }
  }

  await createAuditEntry(db, {
    actor,
    action: "amex.imported",
    objectType: "amex_import",
    objectId: rows[0]?.statementMonth ?? "unknown",
    newValueJson: stringifyJson({ imported, skipped }),
  });

  return { imported, skipped };
}

export async function listAmexLines(
  month: string,
): Promise<AmexStatementLine[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT * FROM amex_statement_lines WHERE statement_month = ? ORDER BY transaction_date ASC`,
    )
    .bind(month)
    .all<AmexStatementLine>();
  return result.results ?? [];
}

export async function updateAmexReconciliation(
  amexLineId: string,
  receiptId: string | null,
  matchStatus: AmexMatchStatus,
  actor: string,
): Promise<void> {
  const db = getReceiptsDb();

  await db
    .prepare(
      `UPDATE amex_statement_lines
       SET matched_receipt_id = ?, match_status = ?
       WHERE id = ?`,
    )
    .bind(receiptId, matchStatus, amexLineId)
    .run();

  if (receiptId && matchStatus === "confirmed") {
    await db
      .prepare(
        `UPDATE receipt_records SET status = 'reconciled', updated_at = ? WHERE id = ?`,
      )
      .bind(nowIso(), receiptId)
      .run();
  }

  await createAuditEntry(db, {
    actor,
    action: "amex.reconciled",
    objectType: "amex_line",
    objectId: amexLineId,
    newValueJson: stringifyJson({ receiptId, matchStatus }),
  });
}

// ─── AMEX statement artifacts ────────────────────────────────────────────────

export async function createAmexArtifact(
  input: CreateAmexArtifactInput,
): Promise<string> {
  const db = getReceiptsDb();
  const id = newUuid();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO amex_statement_artifacts
        (id, statement_month, payment_due_date, card_name, original_filename,
         r2_key, encoding, sha256_hash, file_size_bytes, uploaded_by, uploaded_at,
         import_status, row_count, transaction_count,
         statement_total_amount_cents, parsed_total_amount_cents,
         validation_errors_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.statementMonth,
      input.paymentDueDate,
      input.cardName,
      input.originalFilename,
      input.r2Key,
      input.encoding,
      input.sha256Hash,
      input.fileSizeBytes,
      input.uploadedBy,
      now,
      input.importStatus,
      input.rowCount,
      input.transactionCount,
      input.statementTotalAmountCents,
      input.parsedTotalAmountCents,
      input.validationErrors.length > 0
        ? stringifyJson(input.validationErrors)
        : null,
      now,
      now,
    )
    .run();

  return id;
}

export async function getAmexArtifactBySha256(
  sha256: string,
): Promise<AmexStatementArtifact | null> {
  const db = getReceiptsDb();
  return db
    .prepare(
      `SELECT * FROM amex_statement_artifacts WHERE sha256_hash = ? LIMIT 1`,
    )
    .bind(sha256)
    .first<AmexStatementArtifact>();
}

export async function getAmexArtifactByMonth(
  statementMonth: string,
): Promise<AmexStatementArtifact | null> {
  const db = getReceiptsDb();
  return db
    .prepare(
      `SELECT * FROM amex_statement_artifacts
       WHERE statement_month = ? AND import_status NOT IN ('failed','replaced')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(statementMonth)
    .first<AmexStatementArtifact>();
}

export async function listAmexArtifacts(): Promise<AmexStatementArtifact[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT * FROM amex_statement_artifacts ORDER BY statement_month DESC`,
    )
    .all<AmexStatementArtifact>();
  return result.results ?? [];
}

export async function updateAmexArtifactStatus(
  artifactId: string,
  importStatus: string,
): Promise<void> {
  const db = getReceiptsDb();
  await db
    .prepare(
      `UPDATE amex_statement_artifacts SET import_status = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(importStatus, nowIso(), artifactId)
    .run();
}

export async function markPreviousArtifactsReplaced(
  statementMonth: string,
  exceptId: string,
): Promise<void> {
  const db = getReceiptsDb();
  await db
    .prepare(
      `UPDATE amex_statement_artifacts
       SET import_status = 'replaced', updated_at = ?
       WHERE statement_month = ? AND id != ? AND import_status NOT IN ('failed','replaced')`,
    )
    .bind(nowIso(), statementMonth, exceptId)
    .run();
}

// ─── AMEX line categorization ─────────────────────────────────────────────────

export async function updateAmexLineCategory(
  lineId: string,
  input: UpdateAmexLineCategoryInput,
  actor: string,
): Promise<void> {
  const db = getReceiptsDb();

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (input.expenseCategory !== undefined) {
    sets.push("expense_category = ?");
    binds.push(input.expenseCategory);
    sets.push("category_status = ?");
    binds.push("confirmed");
  }
  if (input.categoryStatus !== undefined) {
    sets.push("category_status = ?");
    binds.push(input.categoryStatus);
  }
  if (input.receiptStatus !== undefined) {
    sets.push("receipt_status = ?");
    binds.push(input.receiptStatus);
  }
  if ("receiptMissingReason" in input) {
    sets.push("receipt_missing_reason = ?");
    binds.push(input.receiptMissingReason ?? null);
  }
  if (input.businessTripStatus !== undefined) {
    sets.push("business_trip_status = ?");
    binds.push(input.businessTripStatus);
  }
  if ("expenseCategoryCode" in input) {
    sets.push("expense_category_code = ?");
    binds.push(input.expenseCategoryCode ?? null);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = ?");
  binds.push(nowIso());
  binds.push(lineId);

  await db
    .prepare(
      `UPDATE amex_statement_lines SET ${sets.join(", ")} WHERE id = ?`,
    )
    .bind(...binds)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "amex.line_categorized",
    objectType: "amex_line",
    objectId: lineId,
    newValueJson: stringifyJson(input),
  });
}

// ─── Dashboard alert dismissals ───────────────────────────────────────────────

export async function dismissAlert(
  alertType: string,
  alertKey: string,
  actor: string,
  expiresAt: string,
): Promise<void> {
  const db = getReceiptsDb();
  const id = newUuid();
  const now = nowIso();

  await db
    .prepare(
      `INSERT OR REPLACE INTO dashboard_alert_dismissals
        (id, alert_type, alert_key, dismissed_by, dismissed_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, alertType, alertKey, actor, now, expiresAt, now)
    .run();
}

export async function getAlertDismissal(
  alertType: string,
  alertKey: string,
  actor: string,
): Promise<DashboardAlertDismissal | null> {
  const db = getReceiptsDb();
  const now = nowIso();
  return db
    .prepare(
      `SELECT * FROM dashboard_alert_dismissals
       WHERE alert_type = ? AND alert_key = ? AND dismissed_by = ? AND expires_at > ?
       LIMIT 1`,
    )
    .bind(alertType, alertKey, actor, now)
    .first<DashboardAlertDismissal>();
}

export async function getMissingStatementAlerts(
  actor: string,
): Promise<MissingStatementAlert[]> {
  const db = getReceiptsDb();

  // Collect the last 3 months that should have statements ready
  const alerts: MissingStatementAlert[] = [];
  const today = new Date();

  for (let offset = 0; offset < 3; offset++) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - offset);
    const statementMonth = d.toISOString().slice(0, 7);

    // Expected ready date: 18th of the prior calendar month
    const readyD = new Date(d);
    readyD.setDate(1);
    readyD.setMonth(readyD.getMonth() - 1);
    readyD.setDate(18);
    const expectedReadyDate = readyD.toISOString().slice(0, 10);

    // Only alert if we've passed the ready date
    if (today.toISOString().slice(0, 10) < expectedReadyDate) continue;

    // Check if artifact already uploaded for this month
    const artifact = await getAmexArtifactByMonth(statementMonth);
    if (artifact) continue;

    // Check if dismissed
    const dismissal = await getAlertDismissal(
      "amex_statement_missing",
      statementMonth,
      actor,
    );

    alerts.push({
      statementMonth,
      expectedReadyDate,
      dismissed: dismissal !== null,
    });
  }

  return alerts.filter((a) => !a.dismissed);
}

// ─── Business trip reports ────────────────────────────────────────────────────

export async function createBusinessTripReports(
  candidates: BusinessTripCandidate[],
  actor: string,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const db = getReceiptsDb();
  const now = nowIso();
  const ids: string[] = [];

  for (const candidate of candidates) {
    const tripId = newUuid();
    await db
      .prepare(
        `INSERT INTO business_trip_reports
          (id, cardholder_name, start_date, end_date, primary_location,
           status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?)`,
      )
      .bind(
        tripId,
        candidate.cardholderName,
        candidate.startDate,
        candidate.endDate,
        candidate.primaryLocation,
        now,
        now,
      )
      .run();

    // Link statement lines to this trip
    for (const lineId of candidate.lineIds) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO business_trip_report_lines
            (id, business_trip_report_id, amex_statement_line_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(newUuid(), tripId, lineId, now)
        .run();

      await db
        .prepare(
          `UPDATE amex_statement_lines
           SET business_trip_id = ?, business_trip_status = 'candidate', updated_at = ?
           WHERE id = ?`,
        )
        .bind(tripId, now, lineId)
        .run();
    }

    await createAuditEntry(db, {
      actor,
      action: "amex.business_trip_detected",
      objectType: "business_trip",
      objectId: tripId,
      newValueJson: stringifyJson(candidate),
    });

    ids.push(tripId);
  }

  return ids;
}

export async function listBusinessTripReports(
  statementMonth?: string,
): Promise<BusinessTripReport[]> {
  const db = getReceiptsDb();
  if (statementMonth) {
    const result = await db
      .prepare(
        `SELECT DISTINCT btr.*
         FROM business_trip_reports btr
         JOIN business_trip_report_lines btrl ON btrl.business_trip_report_id = btr.id
         JOIN amex_statement_lines asl ON asl.id = btrl.amex_statement_line_id
         WHERE asl.statement_month = ?
         ORDER BY btr.start_date ASC`,
      )
      .bind(statementMonth)
      .all<BusinessTripReport>();
    return result.results ?? [];
  }
  const result = await db
    .prepare(
      `SELECT * FROM business_trip_reports ORDER BY start_date DESC`,
    )
    .all<BusinessTripReport>();
  return result.results ?? [];
}

// ─── Expense categories ───────────────────────────────────────────────────────

export interface ExpenseCategoryDbRow {
  code: string;
  ja_name: string;
  en_name: string;
  requires_attendees: number;
  default_business_trip_eligible: number;
  display_order: number;
}

export async function getExpenseCategories(): Promise<ExpenseCategoryDbRow[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(`SELECT * FROM expense_categories ORDER BY display_order ASC`)
    .all<ExpenseCategoryDbRow>();
  return result.results ?? [];
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export async function createExport(
  month: string,
  actor: string,
): Promise<string> {
  const db = getReceiptsDb();

  const existing = await db
    .prepare(
      `SELECT id, status FROM receipt_exports WHERE export_month = ? LIMIT 1`,
    )
    .bind(month)
    .first<{ id: string; status: string }>();

  if (existing?.status === "finalized") {
    throw new Error(`Export for ${month} is already finalized.`);
  }

  if (existing) {
    return existing.id;
  }

  const id = newUuid();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO receipt_exports
        (id, export_month, status, created_by, created_at)
       VALUES (?, ?, 'draft', ?, ?)`,
    )
    .bind(id, month, actor, now)
    .run();

  await createAuditEntry(db, {
    actor,
    action: "export.created",
    objectType: "export",
    objectId: id,
    newValueJson: stringifyJson({ month }),
  });

  return id;
}

export async function getExport(month: string): Promise<ReceiptExport | null> {
  const db = getReceiptsDb();
  return db
    .prepare(`SELECT * FROM receipt_exports WHERE export_month = ? LIMIT 1`)
    .bind(month)
    .first<ReceiptExport>();
}

export async function listExports(): Promise<ReceiptExport[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(`SELECT * FROM receipt_exports ORDER BY export_month DESC`)
    .all<ReceiptExport>();
  return result.results ?? [];
}

export async function finalizeExport(
  exportId: string,
  archiveR2Key: string,
  manifestR2Key: string,
  archiveSha256: string,
  actor: string,
): Promise<void> {
  const db = getReceiptsDb();

  const result = await db
    .prepare(
      `UPDATE receipt_exports
       SET status = 'finalized',
           archive_r2_key = ?,
           manifest_r2_key = ?,
           archive_sha256 = ?,
           finalized_at = ?
       WHERE id = ? AND status = 'draft'`,
    )
    .bind(archiveR2Key, manifestR2Key, archiveSha256, nowIso(), exportId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    throw new Error(
      `Export ${exportId} could not be finalized — it may already be finalized or not found.`,
    );
  }

  await createAuditEntry(db, {
    actor,
    action: "export.finalized",
    objectType: "export",
    objectId: exportId,
    newValueJson: stringifyJson({ archiveR2Key, archiveSha256 }),
  });
}
