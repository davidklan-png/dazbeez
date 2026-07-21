// Server-authoritative, non-destructive duplicate merge. All retained-row and
// attendee mutations plus both audit records commit in one guarded D1 batch.
// Source receipts are read-only and purge remains a separate operator action.

import { isCanonicalCode } from "@/lib/receipts/categories";
import { computeReceiptChecks, persistReceiptChecks } from "@/lib/receipts/compliance";
import { nowIso, newUuid } from "@/lib/receipts/db-utils";
import {
  deriveCandidateStrength,
  fetchMemberAssessment,
  PURGE_TARGET_CAP,
  type MemberAssessmentRecord,
} from "@/lib/receipts/duplicate-purge";
import {
  assessSelection,
  missingPreservationFields,
  type DuplicateMemberInput,
  type PreservationField,
} from "@/lib/receipts/duplicate-resolution-policy";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import { validateInvoiceRegistrationNumber } from "@/lib/receipts/invoice";
import { isMonthLockedForEdits } from "@/lib/receipts/month-lock";
import { parseComplianceSettings } from "@/lib/receipts/settings";
import type {
  DuplicateMergeApiResult,
  FieldResolution,
  ManualAttendeeValue,
  ManualAmountValue,
  ManualAttendeesValue,
} from "@/lib/receipts/duplicate-merge-contract";
import type { ReceiptAttendee, ReceiptFile, ReceiptRecord } from "@/lib/receipts/types";
import { validateAmountMinor, validateCurrency, validateReceiptDate } from "@/lib/receipts/validation";

export type { FieldResolution, ResolutionAction } from "@/lib/receipts/duplicate-merge-contract";

export interface MergeRequest {
  db: D1Database;
  retainedReceiptId: string;
  retainedExpectedUpdatedAt: string;
  sources: Array<{ receiptId: string; expectedUpdatedAt: string }>;
  resolutionPlan: FieldResolution[];
  actor: string;
}

export class MergeError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public month?: string,
  ) {
    super(message);
    this.name = "MergeError";
  }
}

const ALLOWED_FIELDS = new Set<PreservationField>([
  "transaction_date", "merchant", "amount", "category", "business_purpose",
  "alcohol_present", "tax_amount", "tax_rate", "invoice_number",
  "counterparty", "attendees",
]);
const PRE_RECON_STATUSES = new Set(["captured", "needs_review", "reviewed"]);

interface AttendeeSnapshot {
  id: string;
  attendeeName: string;
  company: string | null;
  relationship: string | null;
  isDazbeezEmployee: number;
  notes: string | null;
  createdAt: string;
}

interface LoadedMember {
  assessment: MemberAssessmentRecord;
  attendees: AttendeeSnapshot[];
}

interface CorrectionContext {
  exportId: string;
  month: string;
  revision: number;
  reason: string;
}

function attendeeKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function nonEmptyString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MergeError(400, `${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new MergeError(400, `${label} must be ${max} characters or fewer.`);
  return trimmed;
}

function attendeeSnapshot(row: ReceiptAttendee): AttendeeSnapshot {
  return {
    id: row.id,
    attendeeName: row.attendee_name,
    company: row.company,
    relationship: row.relationship,
    isDazbeezEmployee: row.is_dazbeez_employee,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

async function loadMember(db: D1Database, id: string): Promise<LoadedMember | null> {
  const assessment = await fetchMemberAssessment(db, id);
  if (!assessment) return null;
  const result = await db.prepare(
    `SELECT * FROM receipt_attendees WHERE receipt_id = ? ORDER BY created_at, id`,
  ).bind(id).all<ReceiptAttendee>();
  return { assessment, attendees: (result.results ?? []).map(attendeeSnapshot) };
}

function sourceValue(member: LoadedMember, field: PreservationField): unknown {
  const row = member.assessment.row;
  switch (field) {
    case "transaction_date": return row.transaction_date;
    case "merchant": return row.merchant;
    case "amount": return { amountMinor: row.amount_minor, currency: row.currency };
    case "category": return row.expense_category_code;
    case "business_purpose": return row.business_purpose;
    case "alcohol_present": return row.alcohol_present === 1;
    case "tax_amount": return row.tax_amount_minor;
    case "tax_rate": return row.tax_rate;
    case "invoice_number": return row.invoice_registration_number;
    case "counterparty": return row.counterparty_name;
    case "attendees": return member.attendees;
  }
}

function fieldConflict(members: LoadedMember[], field: PreservationField): boolean {
  const values = members
    .filter((m) => {
      if (field === "attendees") return m.attendees.length > 0;
      return sourceValue(m, field) !== null && sourceValue(m, field) !== "";
    })
    .map((m) => {
      if (field === "attendees") {
        return JSON.stringify(m.attendees.map((a) => attendeeKey(a.attendeeName)).sort());
      }
      return JSON.stringify(sourceValue(m, field));
    });
  return values.length > 1 && new Set(values).size > 1;
}

function validateManualAttendee(value: unknown): ManualAttendeeValue {
  if (!value || typeof value !== "object") throw new MergeError(400, "Each attendee must be an object.");
  const row = value as Record<string, unknown>;
  const attendeeName = nonEmptyString(row.attendeeName, "Attendee name", 200);
  const optional = (key: string, max: number): string | null => {
    const raw = row[key];
    if (raw === undefined || raw === null || raw === "") return null;
    return nonEmptyString(raw, key, max);
  };
  if (row.isDazbeezEmployee !== undefined && typeof row.isDazbeezEmployee !== "boolean") {
    throw new MergeError(400, "isDazbeezEmployee must be boolean.");
  }
  return {
    attendeeName,
    company: optional("company", 200),
    relationship: optional("relationship", 200),
    isDazbeezEmployee: row.isDazbeezEmployee === true,
    notes: optional("notes", 500),
  };
}

function manualAttendees(value: unknown): ManualAttendeeValue[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as ManualAttendeesValue).attendees)) {
    throw new MergeError(400, "Manual attendees must contain an attendees array.");
  }
  const attendees = (value as ManualAttendeesValue).attendees.map(validateManualAttendee);
  if (attendees.length === 0 || attendees.length > 50) {
    throw new MergeError(400, "Manual attendees must contain 1–50 people.");
  }
  return attendees;
}

async function relevantCorrection(
  db: D1Database,
  retained: MemberAssessmentRecord,
): Promise<CorrectionContext | null> {
  if (retained.row.status === "exported" && !retained.row.exported_month) {
    throw new MergeError(409, "Exported retained receipt has no export month; repair lifecycle metadata before merging.");
  }
  const monthRows = await db.prepare(
    `SELECT export_month AS month FROM receipt_exports e
      JOIN receipt_export_items i ON i.export_id=e.id
     WHERE i.item_type='receipt' AND i.item_id=?
     UNION
     SELECT ar.statement_month AS month FROM amex_statement_lines l
      JOIN amex_reconciliations ar ON ar.statement_month=l.statement_month
       AND ar.status='finalized'
     WHERE l.matched_receipt_id=?`,
  ).bind(retained.row.id, retained.row.id).all<{ month: string }>();
  const months = new Set((monthRows.results ?? []).map((r) => r.month));
  if (retained.row.exported_month) months.add(retained.row.exported_month);
  for (const month of months) {
    if (await isMonthLockedForEdits(db, month)) {
      throw new MergeError(
        409,
        `A correction draft is required before editing the retained receipt for ${month}.`,
        "CORRECTION_DRAFT_REQUIRED",
        month,
      );
    }
  }
  if (months.size === 0) return null;
  return db.prepare(
    `SELECT id AS exportId, export_month AS month, export_revision AS revision,
            correction_reason AS reason
       FROM receipt_exports
      WHERE status='draft' AND correction_reason IS NOT NULL
        AND export_month IN (${[...months].map(() => "?").join(",")})
      ORDER BY export_revision DESC LIMIT 1`,
  ).bind(...months).first<CorrectionContext>();
}

function applyScalar(
  proposed: ReceiptRecord,
  field: PreservationField,
  raw: unknown,
): void {
  switch (field) {
    case "transaction_date": {
      const value = nonEmptyString(raw, "Transaction date", 10);
      if (!validateReceiptDate(value)) throw new MergeError(400, `Invalid transaction date: ${value}`);
      proposed.transaction_date = value;
      return;
    }
    case "merchant": proposed.merchant = nonEmptyString(raw, "Merchant", 200); return;
    case "amount": {
      if (!raw || typeof raw !== "object") throw new MergeError(400, "Amount requires amountMinor and currency.");
      const amount = raw as Partial<ManualAmountValue>;
      const parsed = validateAmountMinor(amount.amountMinor);
      if (parsed === null || typeof amount.currency !== "string" || !validateCurrency(amount.currency)) {
        throw new MergeError(400, "Amount requires a non-negative integer amountMinor and supported currency.");
      }
      proposed.amount_minor = parsed;
      proposed.currency = amount.currency.toUpperCase();
      return;
    }
    case "category": {
      const value = nonEmptyString(raw, "Expense category", 80);
      if (!isCanonicalCode(value)) throw new MergeError(400, `Invalid expense category: ${value}`);
      proposed.expense_category_code = value;
      return;
    }
    case "business_purpose": proposed.business_purpose = nonEmptyString(raw, "Business purpose", 500); return;
    case "alcohol_present": {
      if (typeof raw !== "boolean") throw new MergeError(400, "Alcohol present must be boolean.");
      proposed.alcohol_present = raw ? 1 : 0;
      return;
    }
    case "tax_amount": {
      const parsed = validateAmountMinor(raw);
      if (parsed === null) throw new MergeError(400, "Tax amount must be a non-negative integer.");
      proposed.tax_amount_minor = parsed;
      return;
    }
    case "tax_rate": proposed.tax_rate = nonEmptyString(raw, "Tax rate", 16); return;
    case "invoice_number": {
      const value = nonEmptyString(raw, "Invoice registration number", 32);
      const validated = validateInvoiceRegistrationNumber(value);
      if (validated.registrationStatus === "format_invalid") {
        throw new MergeError(400, validated.message ?? "Invalid invoice registration number.");
      }
      proposed.invoice_registration_number = validated.normalizedNumber;
      proposed.invoice_registration_status = validated.registrationStatus;
      proposed.qualified_invoice_status = validated.qualifiedInvoiceStatus;
      return;
    }
    case "counterparty": proposed.counterparty_name = nonEmptyString(raw, "Counterparty", 200); return;
    case "attendees": throw new MergeError(500, "Attendees must use the attendee merge path.");
  }
}

function updateColumns(before: ReceiptRecord, after: ReceiptRecord): Array<[string, unknown]> {
  const fields: Array<[keyof ReceiptRecord, string]> = [
    ["transaction_date", "transaction_date"], ["merchant", "merchant"],
    ["amount_minor", "amount_minor"], ["currency", "currency"],
    ["expense_category_code", "expense_category_code"], ["business_purpose", "business_purpose"],
    ["alcohol_present", "alcohol_present"], ["tax_amount_minor", "tax_amount_minor"],
    ["tax_rate", "tax_rate"], ["invoice_registration_number", "invoice_registration_number"],
    ["invoice_registration_status", "invoice_registration_status"],
    ["qualified_invoice_status", "qualified_invoice_status"], ["counterparty_name", "counterparty_name"],
  ];
  return fields.filter(([key]) => before[key] !== after[key]).map(([key, column]) => [column, after[key]]);
}

async function refreshCompliance(db: D1Database, receiptId: string): Promise<void> {
  const [receipt, attendees, files, settings] = await Promise.all([
    db.prepare(`SELECT * FROM receipt_records WHERE id=?`).bind(receiptId).first<ReceiptRecord>(),
    db.prepare(`SELECT * FROM receipt_attendees WHERE receipt_id=?`).bind(receiptId).all<ReceiptAttendee>(),
    db.prepare(`SELECT * FROM receipt_files WHERE object_type='receipt' AND object_id=?`).bind(receiptId).all<ReceiptFile>(),
    db.prepare(`SELECT key,value FROM receipt_settings`).all<{ key: string; value: string }>(),
  ]);
  if (!receipt) throw new Error("Retained receipt disappeared after merge.");
  await persistReceiptChecks(db, receiptId, computeReceiptChecks({
    receipt,
    attendees: attendees.results ?? [],
    files: files.results ?? [],
    settings: parseComplianceSettings(settings.results ?? []),
  }));
}

export async function applyDuplicateMerge(req: MergeRequest): Promise<DuplicateMergeApiResult> {
  if (!req.actor.trim()) throw new MergeError(400, "Actor is required.");
  if (req.sources.length < 1 || req.sources.length > PURGE_TARGET_CAP) {
    throw new MergeError(400, `Merge requires 1–${PURGE_TARGET_CAP} source receipts.`);
  }
  const sourceIds = req.sources.map((s) => s.receiptId);
  if (sourceIds.includes(req.retainedReceiptId) || new Set(sourceIds).size !== sourceIds.length) {
    throw new MergeError(400, "Sources must be unique and differ from retained.");
  }
  if (req.resolutionPlan.length === 0) throw new MergeError(400, "Resolution plan is empty.");
  const fields = req.resolutionPlan.map((r) => r.field);
  if (new Set(fields).size !== fields.length) throw new MergeError(400, "Each field may be resolved only once.");
  for (const resolution of req.resolutionPlan) {
    if (!ALLOWED_FIELDS.has(resolution.field)) throw new MergeError(400, `Field "${resolution.field}" is not mergeable.`);
    if (!["copy_from_source", "keep_retained", "manual_value"].includes(resolution.action)) {
      throw new MergeError(400, `Invalid action for ${resolution.field}.`);
    }
  }

  const retained = await loadMember(req.db, req.retainedReceiptId);
  if (!retained) throw new MergeError(409, "Retained receipt not found or deleted.");
  if (retained.assessment.row.updated_at !== req.retainedExpectedUpdatedAt) {
    throw new MergeError(409, "Retained receipt changed — reload the comparison.");
  }
  if (retained.assessment.row.payment_path !== "AMEX" || retained.assessment.row.status === "archived") {
    throw new MergeError(409, "Retained receipt must be a non-archived AMEX receipt.");
  }

  const sources: LoadedMember[] = [];
  const strengths: Record<string, "strong" | "near"> = {};
  for (const expected of req.sources) {
    const source = await loadMember(req.db, expected.receiptId);
    if (!source) throw new MergeError(409, `Source ${expected.receiptId.slice(0, 8)} not found or deleted.`);
    const row = source.assessment.row;
    if (row.updated_at !== expected.expectedUpdatedAt) throw new MergeError(409, `Source ${row.id.slice(0, 8)} changed — reload.`);
    if (row.payment_path !== "AMEX" || !PRE_RECON_STATUSES.has(row.status) || isPendingProcessing(row)) {
      throw new MergeError(409, `Source ${row.id.slice(0, 8)} is not an eligible reviewed AMEX duplicate.`);
    }
    if (source.assessment.amexClaimCount > 0 || source.assessment.exportItemsCount > 0) {
      throw new MergeError(409, `Source ${row.id.slice(0, 8)} is protected by a claim or export.`);
    }
    const strength = deriveCandidateStrength(retained.assessment.row, row);
    if (!strength) throw new MergeError(409, `Source ${row.id.slice(0, 8)} is no longer a duplicate candidate.`);
    strengths[row.id] = strength;
    sources.push(source);
  }

  const correction = await relevantCorrection(req.db, retained.assessment);
  const allMembers = [retained, ...sources];
  const initiallyMissing = new Set(
    sources.flatMap((source) => missingPreservationFields(source.assessment.input, retained.assessment.input)),
  );
  const relevant = new Set<PreservationField>([
    ...initiallyMissing,
    ...ALLOWED_FIELDS.values().filter((field) => fieldConflict(allMembers, field)),
  ]);
  for (const resolution of req.resolutionPlan) {
    if (!relevant.has(resolution.field)) throw new MergeError(400, `${resolution.field} is neither missing nor conflicting.`);
    if (resolution.action === "keep_retained" && !fieldConflict(allMembers, resolution.field)) {
      throw new MergeError(400, `keep_retained is valid only for a conflict (${resolution.field}).`);
    }
  }

  const proposed = { ...retained.assessment.row };
  const proposedInput: DuplicateMemberInput = { ...retained.assessment.input };
  const attendeeAdditions: Array<ManualAttendeeValue & { sourceId?: string }> = [];
  const existingNames = new Set(retained.attendees.map((a) => attendeeKey(a.attendeeName)));
  for (const resolution of req.resolutionPlan) {
    if (resolution.action === "keep_retained") continue;
    if (resolution.field === "attendees") {
      let candidates: Array<ManualAttendeeValue & { sourceId?: string }>;
      if (resolution.action === "manual_value") {
        candidates = manualAttendees(resolution.manualValue);
      } else {
        const ids = resolution.sourceReceiptIds ?? [];
        if (ids.length === 0) throw new MergeError(400, "Attendee copy requires one or more sourceReceiptIds.");
        candidates = ids.flatMap((id) => {
          const source = sources.find((s) => s.assessment.row.id === id);
          if (!source) throw new MergeError(400, `Unknown attendee source ${id}.`);
          return source.attendees.map((a) => ({
            attendeeName: a.attendeeName,
            company: a.company,
            relationship: a.relationship,
            isDazbeezEmployee: a.isDazbeezEmployee === 1,
            notes: a.notes,
            sourceId: id,
          }));
        });
      }
      for (const candidate of candidates) {
        const key = attendeeKey(candidate.attendeeName);
        if (key && !existingNames.has(key)) {
          existingNames.add(key);
          attendeeAdditions.push(candidate);
        }
      }
      proposedInput.attendeeNames = [...retained.assessment.input.attendeeNames, ...attendeeAdditions.map((a) => a.attendeeName)];
      proposedInput.attendeesCount = proposedInput.attendeeNames.length;
      continue;
    }
    let raw = resolution.manualValue;
    if (resolution.action === "copy_from_source") {
      const ids = resolution.sourceReceiptIds ?? [];
      if (ids.length !== 1) throw new MergeError(400, `${resolution.field} copy requires exactly one sourceReceiptId.`);
      const source = sources.find((s) => s.assessment.row.id === ids[0]);
      if (!source) throw new MergeError(400, `Unknown source ${ids[0]}.`);
      raw = sourceValue(source, resolution.field);
    }
    applyScalar(proposed, resolution.field, raw);
  }

  Object.assign(proposedInput, {
    transaction_date: proposed.transaction_date,
    merchant: proposed.merchant,
    amount_minor: proposed.amount_minor,
    currency: proposed.currency,
    expense_category_code: proposed.expense_category_code,
    business_purpose: proposed.business_purpose,
    tax_amount_minor: proposed.tax_amount_minor,
    tax_rate: proposed.tax_rate,
    invoice_registration_number: proposed.invoice_registration_number,
    qualified_invoice_status: proposed.qualified_invoice_status,
    counterparty_name: proposed.counterparty_name,
    alcoholPresent: proposed.alcohol_present === 1,
  });

  for (const source of sources) {
    const missing = missingPreservationFields(source.assessment.input, proposedInput);
    if (missing.length > 0) {
      throw new MergeError(422, `Resolve ${missing.join(", ")} before purge; source ${source.assessment.row.id.slice(0, 8)} still has data not preserved.`);
    }
  }
  const postSelection = assessSelection(
    [proposedInput, ...sources.map((s) => s.assessment.input)],
    proposedInput.id,
    sourceIds,
  );
  const nonPreservationBlockers = postSelection.perTarget.flatMap((target) =>
    target.blockers.filter((blocker) => !blocker.includes("missing from the retained") && !blocker.includes("more complete")),
  );
  if (nonPreservationBlockers.length > 0) throw new MergeError(409, nonPreservationBlockers.join(" "));

  const changedColumns = updateColumns(retained.assessment.row, proposed);
  if (changedColumns.length === 0 && attendeeAdditions.length === 0) {
    throw new MergeError(400, "Resolution plan produces no retained-receipt changes.");
  }

  const now = nowIso();
  const mergeId = newUuid();
  const auditId = newUuid();
  const genericAuditId = newUuid();
  const updatedFields = req.resolutionPlan
    .filter((r) => r.action !== "keep_retained")
    .map((r) => r.field);
  const oldValue = {
    receipt: Object.fromEntries(updateColumns(proposed, retained.assessment.row)),
    attendees: retained.attendees,
  };
  const newValue = {
    receipt: Object.fromEntries(changedColumns),
    attendeeAdditions,
  };
  const sourceSnapshots = sources.map((source) => ({
    id: source.assessment.row.id,
    updatedAt: source.assessment.row.updated_at,
    attendees: source.attendees,
  }));
  const statements: D1PreparedStatement[] = [
    req.db.prepare(
      `INSERT INTO duplicate_merge_log
        (id, retained_receipt_id, retained_expected_updated_at,
         retained_attendees_json, source_snapshots_json, actor,
         resolution_plan_json, old_value_json, new_value_json,
         candidate_strengths_json, correction_export_id, correction_month,
         correction_revision, correction_reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      mergeId, req.retainedReceiptId, req.retainedExpectedUpdatedAt,
      JSON.stringify(retained.attendees), JSON.stringify(sourceSnapshots), req.actor,
      JSON.stringify(req.resolutionPlan), JSON.stringify(oldValue), JSON.stringify(newValue),
      JSON.stringify(strengths), correction?.exportId ?? null, correction?.month ?? null,
      correction?.revision ?? null, correction?.reason ?? null, now,
    ),
  ];
  if (changedColumns.length > 0) {
    statements.push(req.db.prepare(
      `UPDATE receipt_records SET ${changedColumns.map(([column]) => `${column}=?`).join(",")}, updated_at=?
        WHERE id=? AND updated_at=? AND deleted_at IS NULL`,
    ).bind(...changedColumns.map(([, value]) => value), now, req.retainedReceiptId, req.retainedExpectedUpdatedAt));
  } else {
    statements.push(req.db.prepare(
      `UPDATE receipt_records SET updated_at=? WHERE id=? AND updated_at=? AND deleted_at IS NULL`,
    ).bind(now, req.retainedReceiptId, req.retainedExpectedUpdatedAt));
  }
  for (const attendee of attendeeAdditions) {
    statements.push(req.db.prepare(
      `INSERT INTO receipt_attendees
        (id,receipt_id,attendee_name,company,relationship,is_dazbeez_employee,notes,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(
      newUuid(), req.retainedReceiptId, attendee.attendeeName, attendee.company ?? null,
      attendee.relationship ?? null, attendee.isDazbeezEmployee ? 1 : 0, attendee.notes ?? null, now,
    ));
  }
  statements.push(
    req.db.prepare(
      `INSERT INTO receipt_audit_log
        (id,actor,action,object_type,object_id,old_value_json,new_value_json,created_at)
       VALUES (?,?,'receipt.updated','receipt',?,?,?,?)`,
    ).bind(genericAuditId, req.actor, req.retainedReceiptId, JSON.stringify(oldValue), JSON.stringify(newValue), now),
    req.db.prepare(
      `INSERT INTO receipt_audit_log
        (id,actor,action,object_type,object_id,old_value_json,new_value_json,created_at)
       VALUES (?,?,'receipt.duplicate_merge_applied','receipt',?,?,?,?)`,
    ).bind(auditId, req.actor, req.retainedReceiptId, JSON.stringify({
      retainedExpectedUpdatedAt: req.retainedExpectedUpdatedAt,
      sources: sourceSnapshots,
      candidateStrengths: strengths,
    }), JSON.stringify({ mergeId, resolutionPlan: req.resolutionPlan, ...newValue, correction }), now),
  );

  try {
    const results = await req.db.batch(statements);
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error("retained update did not affect exactly one row");
    }
  } catch (error) {
    throw new MergeError(
      409,
      `Merge was not applied because a receipt, attendee set, or month lock changed. Reload and try again. (${error instanceof Error ? error.message : "guard failed"})`,
      "MERGE_STALE",
    );
  }

  const warnings: string[] = [];
  try {
    await refreshCompliance(req.db, req.retainedReceiptId);
  } catch (error) {
    console.error("[duplicate-merge] compliance refresh failed after committed merge", error);
    warnings.push("Merge committed, but compliance checks could not be refreshed. Reload Review before purge.");
  }

  return {
    applied: true,
    updatedFields,
    attendeeAdditions: attendeeAdditions.map(({ sourceId: _sourceId, ...attendee }) => attendee),
    resolvedFields: fields,
    warnings,
    correction,
    auditId,
  };
}
