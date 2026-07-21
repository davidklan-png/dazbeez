// Server-authoritative duplicate-merge service.
//
// Resolves target-only and conflicting accounting data from purge targets onto
// the retained canonical receipt BEFORE purge. Nothing is copied automatically —
// the operator provides a resolution plan and the server revalidates everything
// from D1.
//
// The merge NEVER performs purge. Source receipts remain untouched. The retained
// receipt is updated via the existing updateReceiptRecord path (preserving
// compliance checks, membership behavior, sparse-update guarantees) plus a
// dedicated receipt.duplicate_merge_applied audit entry.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import { createAuditEntry } from "@/lib/receipts/audit";
import { updateReceiptRecord } from "@/lib/receipts/db";
import { fetchMemberAssessment, type MemberAssessmentRecord } from "@/lib/receipts/duplicate-purge";
import { findAmexDuplicateCandidates } from "@/lib/receipts/amex-duplicates";
import {
  populatedPreservationFields,
  type DuplicateMemberInput,
  type PreservationField,
} from "@/lib/receipts/duplicate-resolution-policy";
import {
  validateAmountMinor,
  validateCurrency,
  validateReceiptDate,
} from "@/lib/receipts/validation";
import { isCanonicalCode } from "@/lib/receipts/categories";
import { validateInvoiceRegistrationNumber } from "@/lib/receipts/invoice";
import { isMonthLockedForEdits } from "@/lib/receipts/month-lock";
import type { ReceiptRecord, QualifiedInvoiceStatus, UpdateReceiptInput } from "@/lib/receipts/types";

// ─── types ──────────────────────────────────────────────────────────────────

export type ResolutionAction = "copy_from_source" | "keep_retained" | "manual_value";

export interface FieldResolution {
  field: PreservationField;
  action: ResolutionAction;
  /** For copy_from_source: which source receipt to derive the value from. */
  sourceReceiptId?: string;
  /** For manual_value: the operator-entered value (validated server-side). */
  manualValue?: string | number | null;
}

export interface MergeRequest {
  db: D1Database;
  retainedReceiptId: string;
  retainedExpectedUpdatedAt: string;
  sources: Array<{ receiptId: string; expectedUpdatedAt: string }>;
  resolutionPlan: FieldResolution[];
  actor: string;
  /** Operator-entered correction reason (when a correction draft is needed). */
  correctionReason?: string;
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

export interface MergeResult {
  applied: boolean;
  updatedFields: PreservationField[];
  attendeeAdditions: string[];
  correctionMonth?: string;
  auditId: string;
}

// ─── allowlist ──────────────────────────────────────────────────────────────

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "transaction_date", "merchant", "amount", "category", "business_purpose",
  "alcohol_present", "tax_amount", "tax_rate", "invoice_number",
  "counterparty", "attendees",
]);

// ─── merge service ──────────────────────────────────────────────────────────

export async function applyDuplicateMerge(req: MergeRequest): Promise<MergeResult> {
  const db = req.db;

  // ── 1. Validate request shape ──
  if (req.resolutionPlan.length === 0) {
    throw new MergeError(400, "Resolution plan is empty.");
  }
  for (const res of req.resolutionPlan) {
    if (!ALLOWED_FIELDS.has(res.field)) {
      throw new MergeError(400, `Field "${res.field}" is not on the merge allowlist.`);
    }
    if (res.action === "copy_from_source" && !res.sourceReceiptId) {
      throw new MergeError(400, `copy_from_source for "${res.field}" requires sourceReceiptId.`);
    }
  }
  if (req.sources.length === 0) {
    throw new MergeError(400, "At least one source receipt is required.");
  }
  if (req.sources.some((s) => s.receiptId === req.retainedReceiptId)) {
    throw new MergeError(400, "Source receipt must differ from retained.");
  }
  const sourceIds = req.sources.map((s) => s.receiptId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new MergeError(400, "Duplicate source IDs.");
  }

  // ── 2. Load retained + sources from D1 ──
  const retained = await fetchMemberAssessment(db, req.retainedReceiptId);
  if (!retained) {
    throw new MergeError(409, "Retained receipt not found or deleted.");
  }
  if (retained.row.status === "archived") {
    throw new MergeError(409, "Retained receipt is archived.");
  }
  if (retained.row.updated_at !== req.retainedExpectedUpdatedAt) {
    throw new MergeError(409, "Retained receipt changed (stale) — reload the comparison.");
  }

  const sourceRecs: Array<{ rec: MemberAssessmentRecord; expected: string }> = [];
  for (const s of req.sources) {
    const rec = await fetchMemberAssessment(db, s.receiptId);
    if (!rec) throw new MergeError(409, `Source ${s.receiptId.slice(0, 8)} not found or deleted.`);
    if (rec.row.updated_at !== s.expectedUpdatedAt) {
      throw new MergeError(409, `Source ${s.receiptId.slice(0, 8)} changed (stale).`);
    }
    // Revalidate as a duplicate candidate of retained.
    const strength = findAmexDuplicateCandidates(
      [rec.row], [retained.row, rec.row], new Set([retained.row.id]),
    );
    if (!strength.has(rec.row.id)) {
      throw new MergeError(409, `Source ${s.receiptId.slice(0, 8)} is not a duplicate candidate of the retained receipt.`);
    }
    sourceRecs.push({ rec, expected: s.expectedUpdatedAt });
  }

  // ── 3. Check export/reconciliation lock ──
  let correctionMonth: string | undefined;
  if (retained.row.status === "exported" && retained.row.exported_month) {
    const locked = await isMonthLockedForEdits(db, retained.row.exported_month);
    if (locked) {
      throw new MergeError(
        409,
        `A correction draft is required before editing this retained receipt.`,
        "CORRECTION_DRAFT_REQUIRED",
        retained.row.exported_month,
      );
    }
    correctionMonth = retained.row.exported_month;
  }

  // ── 4. Build the update from the resolution plan ──
  const update: UpdateReceiptInput = {};
  const updatedFields: PreservationField[] = [];
  const resolutionLog: Array<{ field: PreservationField; action: ResolutionAction; source?: string; manualValue?: unknown }> = [];
  let attendeeNames: string[] | undefined;

  for (const res of req.resolutionPlan) {
    let valueApplied = false;
    if (res.action === "keep_retained") {
      // No change to the retained field; record the explicit decision.
      resolutionLog.push({ field: res.field, action: "keep_retained" });
      continue;
    }

    let sourceRec: ReceiptRecord | undefined;
    if (res.action === "copy_from_source") {
      const src = sourceRecs.find((s) => s.rec.row.id === res.sourceReceiptId);
      if (!src) throw new MergeError(400, `Unknown source ${res.sourceReceiptId} for "${res.field}".`);
      sourceRec = src.rec.row;
      // Verify the source actually has this field populated.
      const sourcePopulated = new Set(populatedPreservationFields(src.rec.input));
      if (!sourcePopulated.has(res.field)) {
        throw new MergeError(409, `Source ${src.rec.row.id.slice(0, 8)} does not have "${res.field}" populated.`);
      }
    }

    // Apply the field to the update object (validate manual values).
    switch (res.field) {
      case "transaction_date": {
        const val = res.action === "manual_value" ? String(res.manualValue ?? "") : sourceRec!.transaction_date ?? "";
        if (val && !validateReceiptDate(val)) throw new MergeError(400, `Invalid date: ${val}`);
        update.transactionDate = val || null;
        valueApplied = true;
        break;
      }
      case "merchant": {
        const val = res.action === "manual_value" ? String(res.manualValue ?? "").trim() : (sourceRec!.merchant ?? "").trim();
        update.merchant = val || null;
        valueApplied = true;
        break;
      }
      case "amount": {
        // Amount + currency are coupled. For copy_from_source, copy both.
        // For manual_value, the manualValue is the amount; currency stays unless also specified.
        if (res.action === "copy_from_source") {
          update.amountMinor = sourceRec!.amount_minor;
          update.currency = sourceRec!.currency;
        } else {
          const parsed = validateAmountMinor(Number(res.manualValue));
          if (parsed === null) throw new MergeError(400, `Invalid amount: ${res.manualValue}`);
          update.amountMinor = parsed;
        }
        valueApplied = true;
        break;
      }
      case "category": {
        const val = res.action === "manual_value" ? String(res.manualValue ?? "") : sourceRec!.expense_category_code ?? "";
        if (val && !isCanonicalCode(val)) throw new MergeError(400, `Invalid category: ${val}`);
        update.expenseCategoryCode = val || null;
        valueApplied = true;
        break;
      }
      case "business_purpose": {
        const val = res.action === "manual_value" ? String(res.manualValue ?? "").trim() : (sourceRec!.business_purpose ?? "").trim();
        update.businessPurpose = val || null;
        valueApplied = true;
        break;
      }
      case "alcohol_present": {
        const val = res.action === "copy_from_source" ? sourceRec!.alcohol_present === 1 : Boolean(res.manualValue);
        update.alcoholPresent = val;
        valueApplied = true;
        break;
      }
      case "tax_amount": {
        if (res.action === "copy_from_source") {
          update.taxAmountMinor = sourceRec!.tax_amount_minor;
        } else {
          const n = Number(res.manualValue);
          if (isNaN(n) || n < 0) throw new MergeError(400, `Invalid tax amount: ${res.manualValue}`);
          update.taxAmountMinor = Math.round(n);
        }
        valueApplied = true;
        break;
      }
      case "tax_rate": {
        const val = res.action === "manual_value" ? String(res.manualValue ?? "").trim() : (sourceRec!.tax_rate ?? "").trim();
        update.taxRate = val || null;
        valueApplied = true;
        break;
      }
      case "invoice_number": {
        const val = res.action === "manual_value" ? String(res.manualValue ?? "").trim() : (sourceRec!.invoice_registration_number ?? "").trim();
        if (val) {
          const v = validateInvoiceRegistrationNumber(val);
          if (v.registrationStatus === "format_invalid") {
            throw new MergeError(400, v.message ?? `Invalid invoice number: ${val}`);
          }
          update.invoiceRegistrationNumber = v.normalizedNumber;
          // Derive qualified_invoice_status from the invoice authority.
          (update as Record<string, unknown>).qualifiedInvoiceStatus = v.qualifiedInvoiceStatus;
        } else {
          update.invoiceRegistrationNumber = null;
        }
        valueApplied = true;
        break;
      }
      case "counterparty": {
        const val = res.action === "manual_value" ? String(res.manualValue ?? "").trim() : (sourceRec!.counterparty_name ?? "").trim();
        (update as Record<string, unknown>).counterpartyName = val || null;
        valueApplied = true;
        break;
      }
      case "attendees": {
        // Union attendees from retained + source(s), deduplicated.
        if (res.action === "copy_from_source") {
          const srcAttendees = (await db
            .prepare(`SELECT attendee_name FROM receipt_attendees WHERE receipt_id = ? ORDER BY created_at`)
            .bind(res.sourceReceiptId)
            .all<{ attendee_name: string }>()).results ?? [];
          const retainedAttendees = (await db
            .prepare(`SELECT attendee_name FROM receipt_attendees WHERE receipt_id = ? ORDER BY created_at`)
            .bind(req.retainedReceiptId)
            .all<{ attendee_name: string }>()).results ?? [];
          const seen = new Set<string>();
          attendeeNames = [];
          for (const a of [...retainedAttendees, ...srcAttendees]) {
            const name = a.attendee_name.trim();
            if (name && !seen.has(name)) { seen.add(name); attendeeNames.push(name); }
          }
        } else if (res.action === "manual_value" && typeof res.manualValue === "string") {
          // Manual: comma-separated list of attendee names.
          attendeeNames = res.manualValue.split(",").map((s) => s.trim()).filter(Boolean);
        }
        valueApplied = true;
        break;
      }
    }

    if (valueApplied) {
      updatedFields.push(res.field);
      resolutionLog.push({
        field: res.field,
        action: res.action,
        source: res.sourceReceiptId,
        manualValue: res.manualValue,
      });
    }
  }

  // No-op check: if no fields changed and no attendees to add.
  const hasUpdate = Object.keys(update).length > 0 || attendeeNames !== undefined;
  if (!hasUpdate) {
    throw new MergeError(400, "Resolution plan produces no changes (all keep_retained).");
  }

  // ── 5. Apply the retained-field update atomically ──
  // updateReceiptRecord handles compliance, membership, sparse-update, recon-sealed gate.
  if (Object.keys(update).length > 0) {
    await updateReceiptRecord(req.retainedReceiptId, update, req.actor);
  }
  // Attendees handled separately (createAttendees replaces the full set).
  if (attendeeNames !== undefined) {
    const { createAttendees } = await import("@/lib/receipts/db");
    await createAttendees(req.retainedReceiptId, attendeeNames.map((n) => ({ attendeeName: n })), req.actor);
  }

  // ── 6. Write the dedicated merge audit ──
  const auditId = (
    await db
      .prepare(
        `INSERT INTO receipt_audit_log
          (id, actor, action, object_type, object_id, old_value_json, new_value_json, created_at)
         VALUES (?, ?, 'receipt.duplicate_merge_applied', 'receipt', ?, ?, ?, ?)
         RETURNING id`,
      )
      .bind(
        // old/new are summary metadata, not full receipt images.
        crypto.randomUUID(),
        req.actor,
        req.retainedReceiptId,
        JSON.stringify({
          retainedExpectedUpdatedAt: req.retainedExpectedUpdatedAt,
          sources: req.sources.map((s) => ({ id: s.receiptId, expectedUpdatedAt: s.expectedUpdatedAt })),
          resolutionPlan: resolutionLog,
        }),
        JSON.stringify({
          updatedFields,
          attendeeAdditions: attendeeNames ?? [],
          correctionMonth: correctionMonth ?? null,
        }),
        nowIso(),
      )
      .first<{ id: string }>()
  )?.id ?? "unknown";

  return {
    applied: true,
    updatedFields,
    attendeeAdditions: attendeeNames ?? [],
    correctionMonth,
    auditId,
  };
}
