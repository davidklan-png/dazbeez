import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createAuditEntry } from "@/lib/receipts/audit";
import { D1_ID_CHUNK_SIZE, nowIso, newUuid, stringifyJson } from "@/lib/receipts/db-utils";
import {
  assertTransactionMonthEditable,
  isMonthLockedForEdits,
  transactionMonthOf,
} from "@/lib/receipts/month-lock";
import { shouldOverwriteMerchant } from "@/lib/receipts/reconciliation";
import { retentionUntilIso } from "@/lib/receipts/retention";
import { assignMembershipForReceipt, postPatchMembershipDate } from "@/lib/receipts/membership";
import { assertExactlyOneRowWritten } from "@/lib/receipts/operator-message";
import { deleteAmexArtifact } from "@/lib/receipts/storage";
import { PENDING_EXTRACTION_STATES } from "@/lib/receipts/types";
import type { ReceiptAttendeeDirectoryEntry } from "@/lib/receipts/attendee-directory";
import {
  RECENT_CAPTURE_LIMIT,
  type RecentCapture,
} from "@/lib/receipts/recent-captures";
import {
  computeTripStatusLineUpdates,
  findOverlappingTrip,
  decideWiden,
  validateTripTransition,
  type CandidateRow,
  type ExistingTrip,
  type TripTransition,
} from "@/lib/receipts/business-trips";
import type {
  AmexMatchStatus,
  AmexReceiptStatus,
  AmexReconciliation,
  AmexStatementLine,
  AmexStatementArtifact,
  BusinessTripReport,
  BusinessTripCandidate,
  BusinessTripStatus,
  CreateAmexArtifactInput,
  CreateAttendeeInput,
  CreateReceiptInput,
  DashboardAlertDismissal,
  ExtractionState,
  ImportAmexLineInput,
  MissingStatementAlert,
  ReceiptAttendee,
  ReceiptStatus,
  ReceiptExport,
  ReceiptRecord,
  UpdateAmexLineCategoryInput,
  UpdateReceiptInput,
  ExportDelivery,
} from "@/lib/receipts/types";

// ─── Receipt records ─────────────────────────────────────────────────────────

/**
 * preservation_status derived from lifecycle status — migration 0014's backfill
 * CASE as the SINGLE authority (backlog #18 audit / #23). Both capture paths
 * previously hardcoded a literal ('needs_review' / 'captured'), disagreeing with
 * 0014's 'needs_metadata' for status='captured' — three answers for one concept,
 * undetected because nothing reads the column. Pure + unit-tested; no path
 * writes a preservation_status literal. (Existing rows are NOT backfilled here —
 * see backlog #23 + its sealed-month question.)
 */
export function derivePreservationStatus(status: ReceiptStatus | undefined): string {
  switch (status) {
    case "archived":
      return "archived";
    case "exported":
      return "exported";
    case "reconciled":
    case "reviewed":
      return "reviewed";
    case "captured":
      return "needs_metadata";
    default:
      return "needs_review";
  }
}

export async function createReceiptRecord(
  input: CreateReceiptInput,
  actor: string,
): Promise<string> {
  const db = getReceiptsDb();
  const id = newUuid();
  const now = nowIso();

  const paymentPath = input.paymentPath ?? "UNKNOWN";
  const expenseType = input.expenseType ?? "UNKNOWN";

  // Split lock (audit A5): a CASH/DIGITAL receipt may not be inserted with
  // a transaction_date that lands in an already-finalized export month —
  // it must go through the export revision flow. No-op for uploads, which
  // insert at status='captured' with null transaction_date and let the
  // extractor backfill it; this guards callers that supply the date up
  // front (manual create, future import paths). AMEX-path receipts are
  // governed by the reconciliation-sealed gate instead.
  if (paymentPath === "CASH" || paymentPath === "DIGITAL") {
    await assertTransactionMonthEditable(
      transactionMonthOf(input.transactionDate ?? null),
    );
  }

  const sourceType = input.sourceType ?? "manual_upload";

  // ADR 0001: the async capture path inserts at status='captured', which seeds
  // extraction_state='captured' (pending processing). Every other caller keeps
  // the legacy 'needs_review' insert and is therefore 'processed' from the
  // queue's point of view — it never blocks month-close as phantom pending work.
  const status: ReceiptStatus = input.status ?? "needs_review";
  const extractionState: ExtractionState =
    status === "captured" ? "captured" : "processed";

  await db
    .prepare(
      `INSERT INTO receipt_records
        (id, captured_at, captured_by, source, original_filename,
         payment_path, expense_type,
         transaction_date, merchant, amount_minor, currency, tax_amount_minor,
         business_purpose, alcohol_present, attendees_required, status,
         extraction_state,
         original_r2_key, original_sha256, original_content_type, original_size_bytes,
         legacy, retention_until, legal_hold,
         source_type, preservation_status, qualified_invoice_status,
         created_at, updated_at, extraction_r2_key, needs_render,
         device_id, client_capture_id, captured_at_client, upload_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, 'not_checked', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      // attendees_required is derived client-side from category
      // (categoryRequiresAttendees in form-pane.tsx), not stored per-insert.
      0,
      status,
      extractionState,
      input.originalR2Key,
      input.originalSha256,
      input.originalContentType,
      input.originalSizeBytes,
      retentionUntilIso(now),
      sourceType,
      // preservation_status: derived from status via 0014's CASE — no literal
      // on either path (backlog #18 audit / #23).
      derivePreservationStatus(status),
      now,
      now,
      null, // extraction_r2_key — NULL until the Mac render completes (/render).
      // ADR 0011 Phase B: email_body receipts must be rendered to PDF/image on
      // the Mac before MLX extraction. needs_render=1 keeps them out of the
      // pending-extraction query until /render clears it and enqueues.
      sourceType === "email_body" ? 1 : 0,
      // Mobile provenance (backlog #18 merge — createMobileReceiptRecord folded
      // in). NULL for non-mobile captures; the 0015 partial UNIQUE index on
      // (device_id, client_capture_id) only fires when both are NOT NULL, so
      // non-mobile rows never collide. captureReceipt throws
      // CaptureIdempotencyConflict on a collision so the route returns duplicate.
      input.deviceId ?? null,
      input.clientCaptureId ?? null,
      input.capturedAtClient ?? null,
      input.uploadOrigin ?? null,
    )
    .run();

  await createAuditEntry(db, {
    actor,
    action: "receipt.uploaded",
    objectType: "receipt",
    objectId: id,
    // Superset (backlog #18 ii-c(a)): emit mobile provenance when present, so a
    // mobile capture does not silently lose device_id/client_capture_id/
    // app_version/note from this 10-year record's audit trail. app_version +
    // note are audit-JSON ONLY (never columns) — a column diff is blind to them.
    newValueJson: stringifyJson({
      paymentPath,
      expenseType,
      source: input.source ?? "upload",
      ...(input.sourceType ? { source_type: input.sourceType } : {}),
      ...(input.uploadOrigin ? { upload_origin: input.uploadOrigin } : {}),
      ...(input.deviceId ? { device_id: input.deviceId } : {}),
      ...(input.clientCaptureId ? { client_capture_id: input.clientCaptureId } : {}),
      ...(input.appVersion ? { app_version: input.appVersion } : {}),
      ...(input.note ? { note: input.note } : {}),
    }),
  });

  // ADR 0008 (was ADR 0006 PR #2): assign calendar-month membership at capture
  // for CASH/DIGITAL receipts that arrive with a date. The async capture path
  // inserts with no date (status='captured') and is assigned when the extractor
  // backfills the date via updateReceiptRecord. Non-fatal: a failed assignment
  // leaves the receipt created (NULL month), recoverable by setting a date.
  if (
    (paymentPath === "CASH" || paymentPath === "DIGITAL") &&
    input.transactionDate
  ) {
    try {
      await assignMembershipForReceipt(id, input.transactionDate, actor);
    } catch (assignErr) {
      console.error("[createReceiptRecord] membership assignment failed", assignErr);
    }
  }

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

/**
 * Compensating D1 cleanup for a just-inserted receipt whose upload failed part
 * way (audit finding A1) — the upload routes call this when the receipt_files
 * manifest write fails. The receipt was inserted moments ago, nothing downstream
 * has had time to reference it, but every possible reference is cleaned for
 * safety. Atomic via db.batch.
 *
 * ⚠️ SCOPE FOOTGUN (audit 2026-07-21, spec G): this is NOT a complete duplicate
 * purge. It removes D1 rows (and NULLs the AMEX match backreference) but does
 * NOT purge all associated R2 objects, does not transfer business-trip /
 * email-intake / category-rule provenance, does not validate duplicate-purge
 * eligibility, and does not write a purge tombstone. Do not reuse it as a
 * full purge. Operator-confirmed duplicate removal goes through the separate
 * `lib/receipts/duplicate-purge.ts` service (purgeDuplicate), which inventories
 * R2, transfers provenance to the retained receipt, and records a retryable
 * tombstone. The upload routes' compensating-delete behavior is unchanged.
 *
 * Returns true on success, false if the receipt row was already gone
 * (idempotent — caller can retry safely).
 */
export async function hardDeleteReceipt(
  receiptId: string,
  actor: string,
  reason: string,
): Promise<boolean> {
  const db = getReceiptsDb();

  // Order matters: amex_statement_lines.matched_receipt_id has no ON DELETE
  // clause, so we NULL it first or the receipt_records delete would block.
  // receipt_attendees ON DELETE CASCADE handles attendees automatically, but
  // we include them in the batch for explicitness. receipt_files has no FK
  // constraint at all (migration 0014) — would orphan without explicit delete.
  await db.batch([
    db
      .prepare(
        `UPDATE amex_statement_lines
           SET matched_receipt_id = NULL,
               match_status = CASE WHEN match_status IN ('matched','confirmed') THEN 'unmatched' ELSE match_status END
           WHERE matched_receipt_id = ?`,
      )
      .bind(receiptId),
    db
      .prepare(
        `DELETE FROM receipt_files WHERE object_type = 'receipt' AND object_id = ?`,
      )
      .bind(receiptId),
    db
      .prepare(`DELETE FROM receipt_attendees WHERE receipt_id = ?`)
      .bind(receiptId),
    db.prepare(`DELETE FROM receipt_records WHERE id = ?`).bind(receiptId),
  ]);

  await createAuditEntry(db, {
    actor,
    action: "receipt.deleted",
    objectType: "receipt",
    objectId: receiptId,
    newValueJson: stringifyJson({ reason, hardDelete: true }),
  });

  return true;
}

/**
 * Build the SET clause + binds for a receipt update from a sparse input, using
 * `!== undefined` presence (NOT `"field" in input`). Pure (no D1) so the
 * sparse-update behavior is unit-testable: an omitted/undefined field binds
 * nothing (no silent NULL clear of sticky data), explicit null clears a
 * clearable field, and an attendees-only input yields no sets (→ no UPDATE, no
 * generic audit). Exported for tests.
 */
export function buildReceiptUpdateSets(
  input: UpdateReceiptInput,
  before: ReceiptRecord,
): { sets: string[]; binds: unknown[] } {
  const sets: string[] = [];
  const binds: unknown[] = [];

  // Presence = value is not undefined (NOT `"field" in input`). An undefined
  // own property — e.g. an omitted optional field a caller passed through — must
  // NOT trigger a bind: `in` is true for an undefined-valued key and would bind
  // the column to `undefined ?? null` → NULL, silently clearing sticky data
  // (the 2026-07-20 membership-clearing root cause). Explicit null is honored
  // (null !== undefined) for legitimately clearable fields. Applied to every
  // optional field, not only exportStatementMonth.
  if (input.paymentPath !== undefined) { sets.push("payment_path = ?"); binds.push(input.paymentPath); }
  if (input.expenseType !== undefined) { sets.push("expense_type = ?"); binds.push(input.expenseType); }
  if (input.transactionDate !== undefined) { sets.push("transaction_date = ?"); binds.push(input.transactionDate ?? null); }
  if (input.merchant !== undefined) { sets.push("merchant = ?"); binds.push(input.merchant ?? null); }
  if (input.amountMinor !== undefined) { sets.push("amount_minor = ?"); binds.push(input.amountMinor ?? null); }
  if (input.currency !== undefined) { sets.push("currency = ?"); binds.push(input.currency); }
  if (input.taxAmountMinor !== undefined) { sets.push("tax_amount_minor = ?"); binds.push(input.taxAmountMinor ?? null); }
  if (input.businessPurpose !== undefined) { sets.push("business_purpose = ?"); binds.push(input.businessPurpose ?? null); }
  if (input.alcoholPresent !== undefined) { sets.push("alcohol_present = ?"); binds.push(input.alcoholPresent ? 1 : 0); }
  if (input.status !== undefined) { sets.push("status = ?"); binds.push(input.status); }
  if (input.processedR2Key !== undefined) { sets.push("processed_r2_key = ?"); binds.push(input.processedR2Key ?? null); }
  if (input.extractionJson !== undefined) { sets.push("extraction_json = ?"); binds.push(input.extractionJson ?? null); }
  if (input.exportedMonth !== undefined) { sets.push("exported_month = ?"); binds.push(input.exportedMonth ?? null); }
  // ADR 0006 §D6: discretionary override of the sticky export_statement_month.
  // The route guards the target month is export-open and writes the dedicated
  // audit entry; this just applies the column. Explicit override wins over the
  // automatic assignment hook below.
  if (input.exportStatementMonth !== undefined) {
    sets.push("export_statement_month = ?");
    binds.push(input.exportStatementMonth ?? null);
  }
  if (input.expenseCategoryCode !== undefined) { sets.push("expense_category_code = ?"); binds.push(input.expenseCategoryCode ?? null); }
  if (input.sourceType !== undefined) { sets.push("source_type = ?"); binds.push(input.sourceType ?? null); }
  if (input.invoiceRegistrationNumber !== undefined) { sets.push("invoice_registration_number = ?"); binds.push(input.invoiceRegistrationNumber ?? null); }
  if (input.counterpartyName !== undefined) { sets.push("counterparty_name = ?"); binds.push(input.counterpartyName ?? null); }
  if (input.taxRate !== undefined) { sets.push("tax_rate = ?"); binds.push(input.taxRate ?? null); }
  if (input.qualifiedInvoiceStatus !== undefined) { sets.push("qualified_invoice_status = ?"); binds.push(input.qualifiedInvoiceStatus ?? "not_checked"); }
  if (input.extractionState !== undefined) { sets.push("extraction_state = ?"); binds.push(input.extractionState); }
  if (input.extractionEnqueuedAt !== undefined) { sets.push("extraction_enqueued_at = ?"); binds.push(input.extractionEnqueuedAt ?? null); }
  if (input.extractionProcessedAt !== undefined) { sets.push("extraction_processed_at = ?"); binds.push(input.extractionProcessedAt ?? null); }
  if (input.extractionAttempts !== undefined) { sets.push("extraction_attempts = ?"); binds.push(input.extractionAttempts); }
  if (input.extractionProcessor !== undefined) { sets.push("extraction_processor = ?"); binds.push(input.extractionProcessor ?? null); }

  // ADR 0001 root-cause guard: advancing a receipt past extraction (e.g. a
  // human reviews a still-queued capture before the consumer drains it) must
  // clear any stale pending extraction_state, or listPendingProcessingReceipts
  // keeps the month-close gate blocked forever. Only when the caller didn't set
  // the state itself and the row is still pending.
  if (
    input.status !== undefined &&
    input.status !== "captured" &&
    input.extractionState === undefined &&
    before.extraction_state !== undefined &&
    PENDING_EXTRACTION_STATES.includes(before.extraction_state)
  ) {
    sets.push("extraction_state = 'processed'");
  }

  return { sets, binds };
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
  await rejectIfReceiptInFinalizedReconciliation(db, id);
  // Split lock (audit A5): for CASH/DIGITAL receipts, also check the
  // export-finalized gate against the EFFECTIVE transaction month (input
  // override wins, else the existing row's date). AMEX-path receipts skip
  // this — they're covered by the reconciliation-sealed gate above.
  const effectivePaymentPath = input.paymentPath ?? before.payment_path;
  if (effectivePaymentPath === "CASH" || effectivePaymentPath === "DIGITAL") {
    const effectiveDate =
      input.transactionDate !== undefined ? input.transactionDate : before.transaction_date;
    await assertTransactionMonthEditable(transactionMonthOf(effectiveDate));
  }

  const { sets, binds } = buildReceiptUpdateSets(input, before);

  // No receipt-field changes (e.g. an attendees-only PATCH after compaction):
  // do NOT run a synthetic/empty UPDATE and do NOT emit a generic receipt.updated
  // audit. The attendee mutation's own audit (written by the route via
  // createAttendees) is authoritative; the membership hook is skipped too (no
  // assignment on a no-op). The route still performs the attendee mutation and
  // returns the receipt.
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

  // ADR 0008: assign membership whenever a CASH/DIGITAL receipt with a date has
  // NULL export_statement_month after a PATCH — regardless of which field the
  // PATCH touched (see postPatchMembershipDate). This closes the UNKNOWN→CASH
  // classification path: extraction sets the date while payment_path=UNKNOWN,
  // then the operator classifies UNKNOWN→CASH in a PATCH that does NOT touch the
  // date — the previous condition (required "transactionDate" in input) never
  // fired for that flow. Sticky + override-safe (explicit override wins).
  const membershipDate = postPatchMembershipDate({
    effectivePaymentPath,
    beforeExportStatementMonth: before.export_statement_month ?? null,
    explicitOverrideInInput: input.exportStatementMonth !== undefined,
    effectiveTransactionDate:
      (input.transactionDate !== undefined ? input.transactionDate : before.transaction_date) ?? null,
  });
  if (membershipDate) {
    try {
      await assignMembershipForReceipt(id, membershipDate, actor);
    } catch (assignErr) {
      console.error("[updateReceiptRecord] membership assignment failed", assignErr);
    }
  }
}

export async function rejectIfReceiptInFinalizedReconciliation(
  db: D1Database,
  receiptId: string,
): Promise<void> {
  const finalized = await db
    .prepare(
      `SELECT ar.id, ar.statement_month AS statement_month
       FROM amex_statement_lines asl
       JOIN amex_reconciliations ar
         ON ar.statement_month = asl.statement_month
        AND ar.status = 'finalized'
       WHERE asl.matched_receipt_id = ?
       LIMIT 1`,
    )
    .bind(receiptId)
    .first<{ id: string; statement_month: string }>();
  if (!finalized) return;
  // Unified draft carve-out (ADR 0012): a finalized reconciliation releases
  // RECEIPT edits when its statement month has an open export draft — the same
  // single "month open for correction" signal the export lock uses. The
  // LINE-level seal (rejectIfFinalized on amex_statement_lines writes) is
  // intentionally NOT released here: a format-only export revision must not
  // reopen match assignments.
  if (await isMonthLockedForEdits(db, finalized.statement_month)) {
    throw new Error(`Receipt ${receiptId} is locked by a finalized reconciliation.`);
  }
}

export interface ListReceiptsFilter {
  status?: string;
  month?: string;
  /** OR `transaction_date IS NULL` into the month condition so undated
   *  receipts (usually pending extraction — the ones most needing review)
   *  never disappear under a selected month. Ignored when `month` is unset. */
  includeUndated?: boolean;
  paymentPath?: string;
  sourceType?: string;
  qualifiedInvoiceStatus?: string;
  merchant?: string;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  invoiceRegistrationNumber?: string;
  limit?: number;
  offset?: number;
}

export async function listReceiptRecords(
  filter?: ListReceiptsFilter,
  db: D1Database = getReceiptsDb(),
): Promise<ReceiptRecord[]> {
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
    // includeUndated ORs `transaction_date IS NULL` in so pending-extraction
    // (undated) receipts stay visible under a selected month — they are the
    // rows most needing review and must never vanish when a month is picked.
    conditions.push(
      filter.includeUndated
        ? "(transaction_date LIKE ? OR transaction_date IS NULL)"
        : "transaction_date LIKE ?",
    );
    binds.push(`${filter.month}%`);
  }
  if (filter?.sourceType) {
    conditions.push("source_type = ?");
    binds.push(filter.sourceType);
  }
  if (filter?.qualifiedInvoiceStatus) {
    conditions.push("qualified_invoice_status = ?");
    binds.push(filter.qualifiedInvoiceStatus);
  }
  if (filter?.merchant) {
    conditions.push("(merchant LIKE ? OR counterparty_name LIKE ?)");
    binds.push(`%${filter.merchant}%`, `%${filter.merchant}%`);
  }
  if (filter?.minAmountMinor !== undefined) {
    conditions.push("amount_minor >= ?");
    binds.push(filter.minAmountMinor);
  }
  if (filter?.maxAmountMinor !== undefined) {
    conditions.push("amount_minor <= ?");
    binds.push(filter.maxAmountMinor);
  }
  if (filter?.invoiceRegistrationNumber) {
    conditions.push("invoice_registration_number = ?");
    binds.push(filter.invoiceRegistrationNumber);
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

/**
 * Projected "recent captures" slice for the Capture-page rail: the latest
 * non-deleted records by captured_at DESC, returning ONLY the small scalars the
 * rail displays. Deliberately NOT `SELECT *` and excludes `extraction_json`
 * (and every large column) so the rail stays cheap and never ships extraction
 * payloads to the browser. The projected columns mirror {@link RecentCapture}
 * one-for-one — add a field there only if the UI genuinely needs it.
 */
export async function listRecentCaptures(
  limit: number = RECENT_CAPTURE_LIMIT,
): Promise<RecentCapture[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT
         id, captured_at, merchant, original_filename, status,
         extraction_state, needs_render, amount_minor, currency
       FROM receipt_records
       WHERE deleted_at IS NULL
       ORDER BY captured_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<
      Omit<RecentCapture, "extraction_state" | "needs_render"> & {
        extraction_state: RecentCapture["extraction_state"] | null;
        needs_render: RecentCapture["needs_render"] | null;
      }
    >();

  return (result.results ?? []).map((r) => ({
    id: r.id,
    captured_at: r.captured_at,
    merchant: r.merchant,
    original_filename: r.original_filename,
    status: r.status,
    extraction_state: r.extraction_state ?? null,
    needs_render: r.needs_render ?? null,
    amount_minor: r.amount_minor,
    currency: r.currency,
  }));
}

/**
 * Exact `captured today` count from the start of the operator's JST day (the
 * lower-bound ISO is computed by the caller via startOfJstDayIso()). Replaces
 * the previous "load up to RECEIPT_VIEW_LIMIT rows and count in JavaScript",
 * which was both an over-read and wrong on timezones (UTC day, not JST). This
 * is a server COUNT(*) so it's exact and bounded by a single indexed scan.
 */
export async function countCapturedSince(startIso: string): Promise<number> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM receipt_records
       WHERE deleted_at IS NULL AND captured_at >= ?`,
    )
    .bind(startIso)
    .first<{ n: number }>();
  return result?.n ?? 0;
}

/**
 * Exhaustive month-scoped receipt list. Pages internally until exhausted,
 * then throws if the total touches `hardCap` — silent truncation in the
 * export bundle or compliance views would be an audit failure (a receipt
 * omitted from the bundle is a receipt the accountant never sees). Callers
 * that want UI pagination should keep using `listReceiptRecords` with an
 * explicit small limit; this helper is for "I need every row in month M"
 * paths (export bundle, compliance view, finalize validator).
 *
 * The hard cap is set high enough (default 10000) that hitting it signals
 * a real data anomaly rather than routine load — even 4 concurrent open
 * months at operator volume stay well under 1000/month.
 */
export async function listAllReceiptsInMonth(
  month: string,
  opts?: { paymentPath?: string; hardCap?: number; db?: D1Database },
): Promise<ReceiptRecord[]> {
  const paymentPath = opts?.paymentPath;
  const hardCap = opts?.hardCap ?? 10000;
  const db = opts?.db;
  const PAGE = 500;
  const out: ReceiptRecord[] = [];
  let offset = 0;
  // Loop with offset until a page comes back short or we hit the cap.
  for (;;) {
    const page = await listReceiptRecords(
      {
        month,
        paymentPath,
        limit: PAGE,
        offset,
      },
      db,
    );
    out.push(...page);
    if (page.length < PAGE) return out;
    offset += PAGE;
    if (out.length >= hardCap) {
      throw new Error(
        `listAllReceiptsInMonth(${month}) hit hard cap of ${hardCap} rows — ` +
          `silent truncation would corrupt the export bundle. Inspect the data ` +
          `or raise the cap explicitly via opts.hardCap.`,
      );
    }
  }
}

// Projected column list for the Reconcile candidate read. Excludes the two
// heavy text/JSON blobs the reconcile path does not read — `search_text`
// (full-text search copy) and `compliance_warnings_json` — to keep the
// month-window read lean. `extraction_json` IS included: the matcher's
// brand-on-receipt fallback (reconciliation.ts rawTextOf) reads rawText from it.
const RECONCILE_RECEIPT_COLUMNS =
  "id, captured_at, captured_by, source, original_filename, " +
  "payment_path, expense_type, transaction_date, merchant, amount_minor, " +
  "currency, tax_amount_minor, business_purpose, alcohol_present, " +
  "attendees_required, status, original_r2_key, original_sha256, " +
  "original_content_type, original_size_bytes, processed_r2_key, " +
  "extraction_json, legacy, exported_month, export_statement_month, " +
  "expense_category_code, deleted_at, deleted_by, delete_reason, " +
  "retention_until, legal_hold, source_type, preservation_status, " +
  "confirmed_at, confirmed_by, invoice_registration_number, " +
  "invoice_registration_status, qualified_invoice_status, tax_rate, " +
  "counterparty_name, extraction_state, extraction_enqueued_at, " +
  "extraction_processed_at, extraction_attempts, extraction_processor, " +
  "extraction_r2_key, needs_render";

/**
 * Exhaustive AMEX receipt read for the Reconcile candidate window — REPLACES
 * the old global newest-200 query (audit 2026-07-21 Phase 1, Part D). Returns
 * EVERY non-deleted AMEX receipt dated in [start, end] PLUS every non-deleted
 * AMEX receipt with a NULL transaction_date. Undated receipts (pending
 * extraction — the rows most needing review) are fetched in a SEPARATE query so
 * the dated BETWEEN clause keeps using the transaction_date index (and so undated
 * retrieval stays distinct from dated window candidates, per Part D).
 *
 * Never silently truncates: pages internally and THROWS if the combined set
 * reaches `hardCap` (default 5000), since a truncated reconcile view would hide
 * real receipts. extraction_json is included (matcher rawText fallback);
 * search_text and compliance_warnings_json are projected out (unused here).
 */
export async function listAmexReceiptsForReconcile(
  window: { start: string; end: string },
  opts: { hardCap?: number; db?: D1Database } = {},
): Promise<ReceiptRecord[]> {
  const db = opts.db ?? getReceiptsDb();
  const hardCap = opts.hardCap ?? 5000;
  const PAGE = 500;
  const out: ReceiptRecord[] = [];

  // Dated in-window (index-backed via idx_receipts_transaction_date).
  let offset = 0;
  for (;;) {
    const page = await db
      .prepare(
        `SELECT ${RECONCILE_RECEIPT_COLUMNS} FROM receipt_records
         WHERE deleted_at IS NULL AND payment_path = 'AMEX'
           AND transaction_date BETWEEN ? AND ?
         ORDER BY transaction_date ASC LIMIT ? OFFSET ?`,
      )
      .bind(window.start, window.end, PAGE, offset)
      .all<ReceiptRecord>();
    const rows = page.results ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (out.length >= hardCap) {
      throw new Error(
        `listAmexReceiptsForReconcile(${window.start}..${window.end}) hit the hard cap of ${hardCap} dated rows — silent truncation would hide receipts from reconcile. Inspect the data or raise the cap.`,
      );
    }
  }

  // Undated (separate query — see javadoc). Small in practice (pending queue).
  const undated = await db
    .prepare(
      `SELECT ${RECONCILE_RECEIPT_COLUMNS} FROM receipt_records
       WHERE deleted_at IS NULL AND payment_path = 'AMEX'
         AND transaction_date IS NULL`,
    )
    .all<ReceiptRecord>();
  out.push(...(undated.results ?? []));

  if (out.length >= hardCap) {
    throw new Error(
      `listAmexReceiptsForReconcile(${window.start}..${window.end}) hit the hard cap of ${hardCap} after union with undated rows — silent truncation would hide receipts from reconcile.`,
    );
  }

  return out;
}

// Extraction-queue data access (listPendingProcessingReceipts +
// reconcileExtractionState) lives in lib/receipts/extraction-queue-db.ts now;
// re-exported here so existing @/lib/receipts/db import sites are unchanged.
export {
  listPendingProcessingReceipts,
  reconcileExtractionState,
} from "@/lib/receipts/extraction-queue-db";

/**
 * Distinct YYYY-MM transaction months present in the live data, newest first.
 * Feeds the review-queue month picker so the operator can switch to any month
 * that has receipts (not just the months within the current 200-row window).
 * Excludes NULL transaction_dates — those are the undated rows surfaced via
 * includeUndated, not a month of their own.
 */
export async function listDistinctTransactionMonths(): Promise<string[]> {
  const db = getReceiptsDb();
  const res = await db
    .prepare(
      `SELECT DISTINCT substr(transaction_date, 1, 7) AS m
       FROM receipt_records
       WHERE deleted_at IS NULL AND transaction_date IS NOT NULL
       ORDER BY m DESC`,
    )
    .all<{ m: string }>();
  return (res.results ?? []).map((r) => r.m);
}

export async function listReceiptRecordsByIds(
  ids: string[],
): Promise<ReceiptRecord[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const db = getReceiptsDb();
  const records: ReceiptRecord[] = [];

  for (let i = 0; i < uniqueIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT * FROM receipt_records
         WHERE deleted_at IS NULL AND id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<ReceiptRecord>();
    records.push(...(result.results ?? []));
  }

  return records;
}

const DELETABLE_STATUSES = new Set(["captured", "needs_review", "reviewed"]);

export async function softDeleteReceipt(
  id: string,
  actor: string,
  reason?: string,
  db: D1Database = getReceiptsDb(),
): Promise<void> {
  const record = await db
    .prepare(`SELECT id, status, exported_month FROM receipt_records WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ id: string; status: string; exported_month: string | null }>();

  if (!record) throw new Error(`Receipt ${id} not found.`);

  // Unified draft carve-out (ADR 0012): an exported receipt becomes deletable
  // when its month has an open correction draft (isMonthLockedForEdits → false).
  // Other non-deletable statuses (archived, etc.) stay refused. A non-empty
  // reason is mandatory for the exported branch (loud-failure / audit theme).
  const exportCarveout =
    record.status === "exported" &&
    record.exported_month !== null &&
    !(await isMonthLockedForEdits(db, record.exported_month));
  if (!DELETABLE_STATUSES.has(record.status) && !exportCarveout) {
    throw new Error(
      `Receipt cannot be deleted because its status is "${record.status}". Only captured, needs_review, and reviewed receipts may be deleted${
        record.status === "exported"
          ? " (or exported, while a correction draft is open for its month)"
          : ""
      }.`,
    );
  }
  if (record.status === "exported" && (!reason || !reason.trim())) {
    throw new Error(`Deleting an exported receipt requires a non-empty reason.`);
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

// Bulk variant for screens that need attendee names across many receipts in a
// single query (e.g. reconcile detail pane iterating over multiple matched
// lines). Empty input returns an empty Map — D1 rejects empty IN (...) lists.
export async function listAttendeeNamesByReceiptIds(
  receiptIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (receiptIds.length === 0) return out;
  const db = getReceiptsDb();
  // Chunk over D1_ID_CHUNK_SIZE: callers (review queue, reconcile, export) pass
  // 100+ ids for an all-months view, and D1 rejects >100 bound params/statement.
  // Each receipt's rows land in exactly one chunk (chunking is by receipt_id), so
  // per-receipt created_at order is preserved within a chunk.
  for (let i = 0; i < receiptIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = receiptIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT receipt_id, attendee_name
         FROM receipt_attendees
         WHERE receipt_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .bind(...chunk)
      .all<{ receipt_id: string; attendee_name: string }>();
    for (const row of result.results ?? []) {
      let arr = out.get(row.receipt_id);
      if (!arr) {
        arr = [];
        out.set(row.receipt_id, arr);
      }
      arr.push(row.attendee_name);
    }
  }
  return out;
}

// ─── Attendee directory (migration 0022) ──────────────────────────────────────
// The company/title lookup the monthly export bundle joins attendee ids against.
// Resolution against receipt_attendees / amex_line_attendees is by EXACT name
// match (see resolveAttendeeNames); this table is the single source of those
// names + their company/title. Runtime reads live data — the TS seed array
// (ATTENDEE_DIRECTORY_SEED) populated the table once and is now a test fixture.

export async function listAttendeeDirectory(): Promise<ReceiptAttendeeDirectoryEntry[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(`SELECT id, name, company, title FROM attendee_directory ORDER BY id ASC`)
    .all<ReceiptAttendeeDirectoryEntry>();
  return result.results ?? [];
}

/**
 * Register a new attendee directory entry. Id is omitted (SQLite assigns a
 * rowid > 66 so seeded ids 1–66 stay stable). Inputs are trimmed; empty
 * strings are rejected before the call (the route validates), and this is the
 * last line of defense. The UNIQUE(name) constraint is surfaced to the caller
 * via a thrown Error whose message contains "UNIQUE" so the route can map it
 * to a 409 "already registered".
 */
export async function createAttendeeDirectoryEntry(
  input: { name: string; company: string; title: string },
  actor: string,
): Promise<ReceiptAttendeeDirectoryEntry> {
  const name = input.name.trim();
  const company = input.company.trim();
  const title = input.title.trim();
  if (!name || !company || !title) {
    throw new Error("name, company, and title are all required (non-empty).");
  }

  const db = getReceiptsDb();
  const now = nowIso();

  // INSERT without id → SQLite picks the next rowid. RETURNING gives us the
  // assigned id so the caller gets back the exact entry written.
  const inserted = await db
    .prepare(
      `INSERT INTO attendee_directory (name, company, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id, name, company, title`,
    )
    .bind(name, company, title, now, now)
    .first<ReceiptAttendeeDirectoryEntry>();

  // D1 supports RETURNING; if it ever returned null, fall back to a lookup.
  const entry = inserted ?? await db
    .prepare(`SELECT id, name, company, title FROM attendee_directory WHERE name = ?`)
    .bind(name)
    .first<ReceiptAttendeeDirectoryEntry>();

  if (!entry) {
    throw new Error("attendee_directory insert returned no row unexpectedly.");
  }

  await createAuditEntry(db, {
    actor,
    action: "attendee_directory.created",
    objectType: "attendee_directory",
    objectId: String(entry.id),
    newValueJson: stringifyJson({ name: entry.name, company: entry.company, title: entry.title }),
  });

  return entry;
}

/**
 * Update an attendee directory entry's company/title. The name (the identity /
 * join key) is deliberately NOT editable here: receipt_attendees stores attendee
 * names as free text with no FK, so renaming would orphan every receipt still
 * holding the old string AND change what resolveAttendeeNames returns for future
 * builds (a sealed-vs-unsealed drift). Company/title edits are safe — they
 * change what FUTURE bundles resolve, but sealed CSV bytes in R2 are immutable
 * (built at seal time; no re-seal-from-directory path), so a correction does not
 * propagate backwards into a sealed month. Not subject to export-lock (directory
 * rows are not receipt_records / receipt_exports).
 */
export async function updateAttendeeDirectoryEntry(
  id: number,
  input: { company: string; title: string },
  actor: string,
): Promise<ReceiptAttendeeDirectoryEntry> {
  const company = input.company.trim();
  const title = input.title.trim();
  if (!company || !title) {
    throw new Error("company and title are all required (non-empty).");
  }
  const db = getReceiptsDb();
  const now = nowIso();
  const updated = await db
    .prepare(
      `UPDATE attendee_directory SET company = ?, title = ?, updated_at = ?
       WHERE id = ?
       RETURNING id, name, company, title`,
    )
    .bind(company, title, now, id)
    .first<ReceiptAttendeeDirectoryEntry>();
  if (!updated) {
    throw new Error(`Attendee directory entry ${id} not found.`);
  }
  await createAuditEntry(db, {
    actor,
    action: "attendee_directory.updated",
    objectType: "attendee_directory",
    objectId: String(updated.id),
    newValueJson: stringifyJson({ name: updated.name, company: updated.company, title: updated.title }),
  });
  return updated;
}

/**
 * receipt_attendees name → distinct-receipt count (the directory screen's
 * "how many receipts reference each entry" + the source of `attendee_unresolved`
 * at finalize — names present here but NOT in the directory are the unregistered
 * names the gate blocks on). Exact-string match, same as resolveAttendeeNames.
 */
export async function listAttendeeNameReferenceCounts(): Promise<Map<string, number>> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT attendee_name, COUNT(DISTINCT receipt_id) AS n
       FROM receipt_attendees
       GROUP BY attendee_name`,
    )
    .all<{ attendee_name: string; n: number }>();
  return new Map((result.results ?? []).map((r) => [r.attendee_name, r.n]));
}

// ─── AMEX statement lines ─────────────────────────────────────────────────────

export async function importAmexLines(
  rows: ImportAmexLineInput[],
  actor: string,
): Promise<{ inserted: number; updated: number; unchanged: number }> {
  const db = getReceiptsDb();
  const now = nowIso();
  const month = rows[0]?.statementMonth;

  if (!month || rows.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0 };
  }

  // ── Pre-query existing lines to classify inserted / updated / unchanged ──
  const existingResult = await db
    .prepare(
      `SELECT amex_reference, cardholder_name, transaction_date, posting_date,
              merchant, amount_minor, currency, memo, raw_json
       FROM amex_statement_lines
       WHERE statement_month = ?`,
    )
    .bind(month)
    .all<{
      amex_reference: string | null;
      cardholder_name: string | null;
      transaction_date: string;
      posting_date: string | null;
      merchant: string;
      amount_minor: number;
      currency: string;
      memo: string | null;
      raw_json: string;
    }>();

  const existingMap = new Map<
    string,
    (typeof existingResult.results)[number]
  >();
  for (const r of existingResult.results) {
    if (r.amex_reference) {
      existingMap.set(`ref|${r.amex_reference}|${r.cardholder_name ?? ""}`, r);
    } else {
      existingMap.set(
        `noref|${r.transaction_date}|${r.amount_minor}|${r.merchant}|${r.cardholder_name ?? ""}`,
        r,
      );
    }
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const row of rows) {
    if (row.amexReference) {
      const key = `ref|${row.amexReference}|${row.cardholderName ?? ""}`;
      const ex = existingMap.get(key);
      if (!ex) {
        inserted++;
      } else if (
        ex.transaction_date === row.transactionDate &&
        (ex.posting_date ?? "") === (row.postingDate ?? "") &&
        ex.merchant === row.merchant &&
        ex.amount_minor === row.amountMinor &&
        ex.currency === (row.currency ?? "JPY") &&
        (ex.memo ?? "") === (row.memo ?? "") &&
        ex.raw_json === row.rawJson
      ) {
        unchanged++;
      } else {
        updated++;
      }
    } else {
      const key = `noref|${row.transactionDate}|${row.amountMinor}|${row.merchant}|${row.cardholderName ?? ""}`;
      const ex = existingMap.get(key);
      if (!ex) {
        inserted++;
      } else if (
        (ex.posting_date ?? "") === (row.postingDate ?? "") &&
        ex.currency === (row.currency ?? "JPY") &&
        (ex.memo ?? "") === (row.memo ?? "") &&
        ex.raw_json === row.rawJson
      ) {
        unchanged++;
      } else {
        updated++;
      }
    }
  }

  // ── Chunked INSERT … ON CONFLICT DO UPDATE (with amex_reference) ────────
  const withRef = rows.filter((r) => !!r.amexReference);
  const withoutRef = rows.filter((r) => !r.amexReference);
  // Each row binds 25 params (match_status is the SQL literal 'unmatched').
  // receipt_status / receipt_missing_reason are set on first insert only
  // (parser-flagged no-receipt-required lines, e.g. undated annual fees) —
  // re-imports never overwrite them; see ON CONFLICT below.
  // 25 × 3 = 75 < 100 (D1 bind-variable ceiling).
  const CHUNK_SIZE = 3;
  const rowPlaceholder =
    "(?, ?, ?, ?, ?, ?, ?, ?, 'unmatched', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  for (let i = 0; i < withRef.length; i += CHUNK_SIZE) {
    const chunk = withRef.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => rowPlaceholder).join(",");
    const binds: unknown[] = [];
    for (const row of chunk) {
      binds.push(
        newUuid(),
        row.statementMonth,
        row.transactionDate,
        row.postingDate ?? null,
        row.merchant,
        row.amountMinor,
        row.currency ?? "JPY",
        row.amexReference ?? null,
        row.receiptStatus ?? "missing_receipt",
        row.receiptMissingReason ?? null,
        row.rawJson,
        row.statementArtifactId ?? null,
        row.cardholderName ?? null,
        row.cardholderFlag ?? null,
        row.paymentType ?? null,
        row.prepaymentFlag ?? null,
        row.memo ?? null,
        row.foreignAmountMinor ?? null,
        row.foreignCurrency ?? null,
        row.foreignExchangeRate ?? null,
        row.memoCurrencyParseStatus ?? null,
        row.rawCsvLineNumber ?? null,
        row.sourceFileSha256 ?? null,
        now,
        now,
      );
    }
    await db
      .prepare(
        `INSERT INTO amex_statement_lines
          (id, statement_month, transaction_date, posting_date, merchant,
           amount_minor, currency, amex_reference, match_status, receipt_status,
           receipt_missing_reason, raw_json, statement_artifact_id, cardholder_name,
           cardholder_flag, payment_type, prepayment_flag, memo, foreign_amount_minor,
           foreign_currency, foreign_exchange_rate, memo_currency_parse_status,
           raw_csv_line_number, source_file_sha256, imported_at, created_at)
         VALUES ${placeholders}
         ON CONFLICT (statement_month, amex_reference, cardholder_name) DO UPDATE SET
           transaction_date = excluded.transaction_date,
           posting_date = excluded.posting_date,
           merchant = excluded.merchant,
           amount_minor = excluded.amount_minor,
           currency = excluded.currency,
           cardholder_name = excluded.cardholder_name,
           memo = excluded.memo,
           foreign_amount_minor = excluded.foreign_amount_minor,
           foreign_currency = excluded.foreign_currency,
           foreign_exchange_rate = excluded.foreign_exchange_rate,
           memo_currency_parse_status = excluded.memo_currency_parse_status,
           raw_csv_line_number = excluded.raw_csv_line_number,
           source_file_sha256 = excluded.source_file_sha256,
           statement_artifact_id = excluded.statement_artifact_id,
           imported_at = excluded.imported_at,
           raw_json = excluded.raw_json,
           re_review_needed = CASE
             WHEN match_status = 'confirmed'
               AND (transaction_date IS NOT excluded.transaction_date
                 OR merchant IS NOT excluded.merchant
                 OR amount_minor IS NOT excluded.amount_minor)
             THEN 1
             ELSE re_review_needed
           END`,
      )
      .bind(...binds)
      .run();
  }

  // ── Upsert for rows without amex_reference (rare edge case) ───
  for (let i = 0; i < withoutRef.length; i += CHUNK_SIZE) {
    const chunk = withoutRef.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => rowPlaceholder).join(",");
    const binds: unknown[] = [];
    for (const row of chunk) {
      binds.push(
        newUuid(),
        row.statementMonth,
        row.transactionDate,
        row.postingDate ?? null,
        row.merchant,
        row.amountMinor,
        row.currency ?? "JPY",
        row.amexReference ?? null,
        row.receiptStatus ?? "missing_receipt",
        row.receiptMissingReason ?? null,
        row.rawJson,
        row.statementArtifactId ?? null,
        row.cardholderName ?? null,
        row.cardholderFlag ?? null,
        row.paymentType ?? null,
        row.prepaymentFlag ?? null,
        row.memo ?? null,
        row.foreignAmountMinor ?? null,
        row.foreignCurrency ?? null,
        row.foreignExchangeRate ?? null,
        row.memoCurrencyParseStatus ?? null,
        row.rawCsvLineNumber ?? null,
        row.sourceFileSha256 ?? null,
        now,
        now,
      );
    }
    await db
      .prepare(
        `INSERT INTO amex_statement_lines
          (id, statement_month, transaction_date, posting_date, merchant,
           amount_minor, currency, amex_reference, match_status, receipt_status,
           receipt_missing_reason, raw_json, statement_artifact_id, cardholder_name,
           cardholder_flag, payment_type, prepayment_flag, memo, foreign_amount_minor,
           foreign_currency, foreign_exchange_rate, memo_currency_parse_status,
           raw_csv_line_number, source_file_sha256, imported_at, created_at)
         VALUES ${placeholders}
         ON CONFLICT (statement_month, transaction_date, amount_minor, merchant, cardholder_name)
           WHERE amex_reference IS NULL
         DO UPDATE SET
           posting_date = excluded.posting_date,
           currency = excluded.currency,
           memo = excluded.memo,
           foreign_amount_minor = excluded.foreign_amount_minor,
           foreign_currency = excluded.foreign_currency,
           foreign_exchange_rate = excluded.foreign_exchange_rate,
           memo_currency_parse_status = excluded.memo_currency_parse_status,
           raw_csv_line_number = excluded.raw_csv_line_number,
           source_file_sha256 = excluded.source_file_sha256,
           statement_artifact_id = excluded.statement_artifact_id,
           imported_at = excluded.imported_at,
           raw_json = excluded.raw_json`,
      )
      .bind(...binds)
      .run();
  }

  await createAuditEntry(db, {
    actor,
    action: "amex.imported",
    objectType: "amex_import",
    objectId: month,
    newValueJson: stringifyJson({ inserted, updated, unchanged }),
  });

  return { inserted, updated, unchanged };
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

export interface AmexMatchFlags {
  hasMatch: boolean;
  reReviewNeeded: boolean;
}

export async function getAmexMatchFlagsByReceiptIds(
  receiptIds: string[],
): Promise<Map<string, AmexMatchFlags>> {
  const flags = new Map<string, AmexMatchFlags>();
  if (receiptIds.length === 0) return flags;

  const db = getReceiptsDb();
  // Chunk over D1_ID_CHUNK_SIZE: the review queue passes 100+ ids for an
  // all-months view, and D1 rejects >100 bound params per statement.
  for (let i = 0; i < receiptIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = receiptIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT matched_receipt_id, re_review_needed
         FROM amex_statement_lines
         WHERE matched_receipt_id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<{ matched_receipt_id: string; re_review_needed: 0 | 1 }>();

    for (const row of result.results ?? []) {
      const existing = flags.get(row.matched_receipt_id);
      flags.set(row.matched_receipt_id, {
        hasMatch: true,
        reReviewNeeded:
          (existing?.reReviewNeeded ?? false) || row.re_review_needed === 1,
      });
    }
  }
  return flags;
}

export async function listAmexLineAttendeeNamesByMonth(
  statementMonth: string,
): Promise<Record<string, string[]>> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT ala.amex_statement_line_id, ala.attendee_name
       FROM amex_line_attendees ala
       JOIN amex_statement_lines asl ON asl.id = ala.amex_statement_line_id
       WHERE asl.statement_month = ?
       ORDER BY ala.created_at ASC`,
    )
    .bind(statementMonth)
    .all<{ amex_statement_line_id: string; attendee_name: string }>();

  const attendeesByLine: Record<string, string[]> = {};
  for (const row of result.results ?? []) {
    attendeesByLine[row.amex_statement_line_id] ??= [];
    attendeesByLine[row.amex_statement_line_id]!.push(row.attendee_name);
  }

  return attendeesByLine;
}

/**
 * Every AMEX statement line matched to one of `receiptIds`, across ALL statement
 * months (a receipt matched to lines in two months is the cross-month ambiguity
 * case). Ordered by statement_month then transaction_date for stable display.
 * Used by the review-queue closing-attention collector to run the full per-line
 * sign-off rules + cross-month grouping over a working set's receipts in one
 * batched query (no per-receipt round-trips).
 */
export async function listAmexLinesByMatchedReceiptIds(
  receiptIds: string[],
): Promise<AmexStatementLine[]> {
  const ids = [...new Set(receiptIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const db = getReceiptsDb();
  const out: AmexStatementLine[] = [];
  const CHUNK = D1_ID_CHUNK_SIZE;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT * FROM amex_statement_lines
         WHERE matched_receipt_id IN (${placeholders})
         ORDER BY statement_month ASC, transaction_date ASC`,
      )
      .bind(...chunk)
      .all<AmexStatementLine>();
    out.push(...(result.results ?? []));
  }
  return out;
}

/**
 * Direct amex_line_attendees for a specific set of line ids, keyed by line id.
 * The by-line variant of {@link listAmexLineAttendeeNamesByMonth}: the
 * closing-attention collector loads only the lines matched to the working set
 * (which may span months), so it needs attendees for exactly those lines rather
 * than every line in a month.
 */
export async function listAmexLineAttendeeNamesByLineIds(
  lineIds: string[],
): Promise<Record<string, string[]>> {
  const ids = [...new Set(lineIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const db = getReceiptsDb();
  const attendeesByLine: Record<string, string[]> = {};
  const CHUNK = D1_ID_CHUNK_SIZE;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT amex_statement_line_id, attendee_name
         FROM amex_line_attendees
         WHERE amex_statement_line_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .bind(...chunk)
      .all<{ amex_statement_line_id: string; attendee_name: string }>();
    for (const row of result.results ?? []) {
      attendeesByLine[row.amex_statement_line_id] ??= [];
      attendeesByLine[row.amex_statement_line_id]!.push(row.attendee_name);
    }
  }
  return attendeesByLine;
}

export async function updateAmexReconciliation(
  amexLineId: string,
  receiptId: string | null,
  matchStatus: AmexMatchStatus,
  actor: string,
  db: D1Database = getReceiptsDb(),
): Promise<void> {
  const now = nowIso();

  // Capture previous state for two reasons:
  //   1. Audit log records the transition (oldValueJson), so a
  //      confirmed → unmatched transition no longer silently orphans the
  //      previously-matched receipt from the audit trail.
  //   2. Demote logic below: when we unwind a confirmed match, the
  //      previously-matched receipt was promoted to 'reconciled' — it
  //      needs to go back to 'needs_review' so it doesn't sit stuck as
  //      reconciled with no AMEX line claiming it.
  const previous = await db
    .prepare(
      `SELECT matched_receipt_id, match_status, receipt_status,
              merchant, transaction_date, statement_month
       FROM amex_statement_lines
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(amexLineId)
    .first<{
      matched_receipt_id: string | null;
      match_status: AmexMatchStatus;
      receipt_status: AmexReceiptStatus;
      merchant: string | null;
      transaction_date: string | null;
      statement_month: string | null;
    }>();

  const previousReceiptId = previous?.matched_receipt_id ?? null;
  const previousStatus: AmexMatchStatus = previous?.match_status ?? "unmatched";
  const previousReceiptStatus: AmexReceiptStatus = previous?.receipt_status ?? "missing_receipt";
  const amexMerchant = previous?.merchant ?? null;
  const amexTransactionDate = previous?.transaction_date ?? null;
  const statementMonth = previous?.statement_month;

  // Block edits if the month's reconciliation is finalized.
  if (statementMonth) {
    await rejectIfFinalized(db, statementMonth);
  }

  // Derive receipt_status from the new match_status so the two fields stay in
  // sync. The month-closing validator checks both — drift causes false blockers.
  const noReceiptKeep = new Set<AmexReceiptStatus>(["no_receipt_required", "receipt_not_available"]);
  let newReceiptStatus: AmexReceiptStatus;
  switch (matchStatus) {
    case "confirmed":
    case "matched":
      newReceiptStatus = "matched";
      break;
    case "no_receipt":
      newReceiptStatus = noReceiptKeep.has(previousReceiptStatus) ? previousReceiptStatus : "no_receipt_required";
      break;
    case "unmatched":
      newReceiptStatus = "missing_receipt";
      break;
  }

  // Multiple confirmed lines MAY share one receipt: a consolidated 領収書
  // covers several card charges (e.g. two same-night HUB charges on one
  // receipt). The former 1:1 race guard that threw here is intentionally
  // gone. Sum-vs-receipt-total integrity is enforced as a sign-off blocker
  // (validateAmexLinesForSignoff), not at confirm time, so partial groups
  // can be linked incrementally during the month.
  //
  // What is NOT allowed (Codex review P2, 2026-07-08): confirming a receipt
  // that is already confirmed against a line in a DIFFERENT statement month
  // whose reconciliation is finalized. rejectIfFinalized above only checks
  // the target line's month, so without this guard a sealed month's receipt
  // could be re-claimed — and this function would then mutate that receipt's
  // merchant/date/status, breaking finalized-month immutability. Same-month
  // consolidated siblings pass; cross-month links into open months are left
  // to the export gate's cross-month integrity blocker.
  if (matchStatus === "confirmed" && receiptId) {
    const sealedClaim = await db
      .prepare(
        `SELECT asl.statement_month
         FROM amex_statement_lines asl
         JOIN amex_reconciliations ar
           ON ar.statement_month = asl.statement_month
          AND ar.status = 'finalized'
         WHERE asl.matched_receipt_id = ?
           AND asl.match_status = 'confirmed'
           AND asl.id != ?
           AND asl.statement_month != ?
         LIMIT 1`,
      )
      .bind(receiptId, amexLineId, statementMonth ?? "")
      .first<{ statement_month: string }>();
    if (sealedClaim) {
      throw new Error(
        `Receipt is confirmed in the finalized reconciliation for ${sealedClaim.statement_month} and cannot be linked to another month. Reopen that month first.`,
      );
    }
  }

  const statements = [
    db
      .prepare(
      `UPDATE amex_statement_lines
         SET matched_receipt_id = ?,
             match_status = ?,
             receipt_status = ?,
             re_review_needed = CASE WHEN ? = 'confirmed' THEN 0 ELSE re_review_needed END
         WHERE id = ?`,
      )
      .bind(receiptId, matchStatus, newReceiptStatus, matchStatus, amexLineId),
  ];

  // Promote the newly-linked receipt and adopt AMEX values.
  let receiptAdoptAudit: {
    oldMerchant: string | null;
    newMerchant: string | null;
    filledDate: string | null;
  } | null = null;
  // Hoisted to function scope so the amex.reconciled audit below can record it
  // even when no merchant/date adoption happened.
  let classifyAsAmex = false;

  if (receiptId && matchStatus === "confirmed") {
    // Read the receipt's current merchant/transaction_date/payment_path to
    // decide whether the AMEX override is a no-op (and to populate the audit
    // trail). payment_path drives the tentative-match → AMEX classification.
    const receiptRow = await db
      .prepare(
        `SELECT merchant, transaction_date, payment_path FROM receipt_records WHERE id = ? LIMIT 1`,
      )
      .bind(receiptId)
      .first<{ merchant: string | null; transaction_date: string | null; payment_path: string }>();

    const receiptMerchant = receiptRow?.merchant ?? null;
    const receiptDate = receiptRow?.transaction_date ?? null;
    const receiptPaymentPath = receiptRow?.payment_path ?? null;

    const merchantChanged = shouldOverwriteMerchant(amexMerchant, receiptMerchant);

    const dateFill = !receiptDate && !!amexTransactionDate;

    // Confirming a tentative UNKNOWN-payment match classifies the receipt as
    // AMEX in the SAME batch as the match confirmation — a receipt must never
    // be observable as matched + still UNKNOWN, even transiently. Gated
    // strictly on UNKNOWN; an already-declared AMEX/CASH/DIGITAL receipt is
    // never touched here. 'AMEX' is a fixed classification, inlined as a
    // literal (not a bind param). Appended to BOTH UPDATE branches below so the
    // flip lands regardless of which branch runs.
    classifyAsAmex = receiptPaymentPath === "UNKNOWN";
    const paymentPathFragment = classifyAsAmex ? ", payment_path = 'AMEX'" : "";

    if (merchantChanged || dateFill) {
      receiptAdoptAudit = {
        oldMerchant: receiptMerchant,
        newMerchant: merchantChanged ? amexMerchant : receiptMerchant,
        filledDate: dateFill ? amexTransactionDate : null,
      };
      statements.push(
        db
          .prepare(
            `UPDATE receipt_records
             SET merchant = ?,
                 transaction_date = COALESCE(transaction_date, ?),
                 status = 'reconciled',
                 updated_at = ?${paymentPathFragment}
             WHERE id = ?`,
          )
          .bind(
            merchantChanged ? amexMerchant : receiptMerchant,
            amexTransactionDate,
            now,
            receiptId,
          ),
      );
    } else {
      // No merchant/date change — just promote status.
      statements.push(
        db
          .prepare(
            `UPDATE receipt_records SET status = 'reconciled', updated_at = ?${paymentPathFragment} WHERE id = ?`,
          )
          .bind(now, receiptId),
      );
    }
  }

  // Demote the previously-linked receipt if we're unwinding its confirmation
  // (either dropping the link entirely or switching to a different receipt).
  // Guard with `status = 'reconciled'` so we don't clobber a status another
  // process may have advanced this receipt to in the meantime.
  // Consolidated receipts: only demote when NO other confirmed line still
  // references it — unlinking one of two grouped lines must not knock a
  // still-claimed receipt back to needs_review. The NOT EXISTS guard is
  // evaluated inside the same batch as the line update, so it sees a
  // consistent view.
  const wasConfirmed = previousStatus === "confirmed";
  if (wasConfirmed && previousReceiptId && previousReceiptId !== receiptId) {
    statements.push(
      db
        .prepare(
          `UPDATE receipt_records
           SET status = 'needs_review', updated_at = ?
           WHERE id = ? AND status = 'reconciled'
             AND NOT EXISTS (
               SELECT 1 FROM amex_statement_lines
               WHERE matched_receipt_id = ?
                 AND match_status = 'confirmed'
                 AND id != ?
             )`,
        )
        .bind(now, previousReceiptId, previousReceiptId, amexLineId),
    );
  }

  // Single batched round-trip so the AMEX line update, the new-receipt
  // promotion, and the old-receipt demotion either all succeed or all fail.
  // Previously these were three independent awaits with no rollback path.
  await db.batch(statements);

  await createAuditEntry(db, {
    actor,
    action: "amex.reconciled",
    objectType: "amex_line",
    objectId: amexLineId,
    oldValueJson: stringifyJson({
      receiptId: previousReceiptId,
      matchStatus: previousStatus,
      receiptStatus: previousReceiptStatus,
    }),
    newValueJson: stringifyJson({
      receiptId,
      matchStatus,
      receiptStatus: newReceiptStatus,
      // Traceable record that this confirm also classified an UNKNOWN receipt
      // as AMEX (audit-everything convention — never an invisible side effect).
      ...(classifyAsAmex
        ? { classifiedPaymentPath: { from: "UNKNOWN", to: "AMEX" } }
        : {}),
    }),
  });

  // Second audit entry when AMEX values were adopted onto the receipt.
  if (receiptAdoptAudit && receiptId) {
    await createAuditEntry(db, {
      actor,
      action: "receipt.updated",
      objectType: "receipt",
      objectId: receiptId,
      oldValueJson: stringifyJson({
        merchant: receiptAdoptAudit.oldMerchant,
        transactionDateFilled: false,
      }),
      newValueJson: stringifyJson({
        merchant: receiptAdoptAudit.newMerchant,
        transactionDateFilled: receiptAdoptAudit.filledDate !== null,
        ...(receiptAdoptAudit.filledDate ? { transactionDate: receiptAdoptAudit.filledDate } : {}),
        source: "amex_confirm_override",
      }),
    });
  }
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
         validation_errors_json, retention_until, legal_hold, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
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
      retentionUntilIso(now),
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
  // Exclude 'failed' and 'replaced' artifacts — a prior import that failed
  // validation never actually inserted any line items, so it must not
  // permanently block re-uploading the identical file once the underlying
  // issue is fixed (e.g. a parser bug). Same filter as getAmexArtifactByMonth
  // below, for the same reason.
  return db
    .prepare(
      `SELECT * FROM amex_statement_artifacts
       WHERE sha256_hash = ? AND import_status NOT IN ('failed', 'replaced')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(sha256)
    .first<AmexStatementArtifact>();
}

// Purge stale failed/replaced artifact rows for a given file hash so a fresh
// INSERT with the same sha256_hash can succeed. The application-layer dedup
// check (getAmexArtifactBySha256) excludes these rows, but the DB-level
// UNIQUE constraint on sha256_hash (db/receipts/0005_amex_extended.sql:31)
// still fires on INSERT because the row physically exists. Purging right
// before createAmexArtifact() closes that gap.
//
// Non-fatal R2 cleanup: each row's R2 object is deleted best-effort. R2
// failures are logged but do not block the DB cleanup — same "non-fatal,
// log and continue" pattern as the manifest write in the import route.
//
// Audit: ONE entry is written per purge call (action:
// amex_statement.failed_artifact_purged), so the trail shows who triggered
// the re-upload that caused the purge. receipt_audit_log rows for the
// purged artifacts are intentionally NOT deleted (append-only, tax/
// compliance retention).
export async function purgeFailedAmexArtifactsByHash(
  sha256: string,
  actor: string,
): Promise<void> {
  const db = getReceiptsDb();

  const stale = await db
    .prepare(
      `SELECT id, r2_key FROM amex_statement_artifacts
       WHERE sha256_hash = ? AND import_status IN ('failed', 'replaced')`,
    )
    .bind(sha256)
    .all<{ id: string; r2_key: string }>();

  const staleRows = stale.results ?? [];
  if (staleRows.length === 0) return;

  const staleIds = staleRows.map((r) => r.id);

  // Best-effort R2 cleanup. Failure here does not block the DB purge.
  for (const row of staleRows) {
    try {
      await deleteAmexArtifact(row.r2_key);
    } catch (err) {
      console.error(
        `[purgeFailedAmexArtifactsByHash] R2 delete failed for key ${row.r2_key}`,
        err,
      );
    }
  }

  // Atomic DB cleanup: delete manifest rows first (FK-ish reference via
  // object_type/object_id, no formal FK constraint), then the artifact
  // rows themselves. db.batch runs both in a single transaction.
  const placeholders = staleIds.map(() => "?").join(", ");
  await db.batch([
    db
      .prepare(
        `DELETE FROM receipt_files
         WHERE object_type = 'amex_statement_artifact'
           AND object_id IN (${placeholders})`,
      )
      .bind(...staleIds),
    db
      .prepare(
        `DELETE FROM amex_statement_artifacts WHERE id IN (${placeholders})`,
      )
      .bind(...staleIds),
  ]);

  await createAuditEntry(db, {
    actor,
    action: "amex_statement.failed_artifact_purged",
    objectType: "amex_statement_artifact",
    objectId: staleIds.join(","),
    newValueJson: JSON.stringify({
      sha256,
      purgedCount: staleIds.length,
      purgedIds: staleIds,
    }),
  });
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

  // Block edits if the month's reconciliation is finalized.
  const lineMonth = await db
    .prepare(`SELECT statement_month FROM amex_statement_lines WHERE id = ? LIMIT 1`)
    .bind(lineId)
    .first<{ statement_month: string }>();
  if (lineMonth?.statement_month) {
    await rejectIfFinalized(db, lineMonth.statement_month);
  }

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
): Promise<{
  created: number;
  linked: number;
  widened: number;
  widenedSkipped: number;
}> {
  if (candidates.length === 0) {
    return { created: 0, linked: 0, widened: 0, widenedSkipped: 0 };
  }
  const db = getReceiptsDb();
  const now = nowIso();
  let created = 0;
  let linked = 0;
  let widened = 0;
  let widenedSkipped = 0;

  for (const candidate of candidates) {
    // ADR 0010 D1 dedupe: link to an existing same-cardholder overlapping trip
    // instead of minting a fresh UUID each run (the re-import duplicate defect).
    const existing = await db
      .prepare(
        `SELECT id, cardholder_name, start_date, end_date, status
         FROM business_trip_reports
         WHERE cardholder_name = ? AND status IN ('candidate','confirmed')`,
      )
      .bind(candidate.cardholderName)
      .all<ExistingTrip>();
    const match = findOverlappingTrip(candidate, existing.results ?? []);

    if (match) {
      const stmts = buildTripLineLinkStmts(db, match.id, candidate.lineIds, now);
      const widen = decideWiden(match, candidate);
      if (widen.kind === "widen") {
        stmts.push(
          db
            .prepare(
              `UPDATE business_trip_reports
               SET start_date = ?, end_date = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(widen.range.start, widen.range.end, now, match.id),
        );
      }
      await batchWrite(db, stmts);
      await createAuditEntry(db, {
        actor,
        action: "business_trip.members_changed",
        objectType: "business_trip",
        objectId: match.id,
        newValueJson: stringifyJson({
          source: "detection_dedupe",
          lineIds: candidate.lineIds,
          range: widen.kind,
        }),
      });
      linked += 1;
      if (widen.kind === "widen") widened += 1;
      else if (widen.kind === "skip") widenedSkipped += 1;
      continue;
    }

    // No overlap → create a new candidate trip (detection suggestion).
    const tripId = newUuid();
    const insertStmt = db
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
      );
    const linkStmts = buildTripLineLinkStmts(db, tripId, candidate.lineIds, now);
    await batchWrite(db, [insertStmt, ...linkStmts]);

    await createAuditEntry(db, {
      actor,
      action: "amex.business_trip_detected",
      objectType: "business_trip",
      objectId: tripId,
      newValueJson: stringifyJson(candidate),
    });
    created += 1;
  }

  return { created, linked, widened, widenedSkipped };
}

/**
 * Build the link-table INSERTs + line-status UPDATEs that attach `lineIds` to
 * a trip. Detection links set line status 'candidate' only for lines not
 * already 'confirmed'/'excluded' (never clobber an operator decision). Chunked
 * for D1's per-statement bind ceiling (20 lines × 4 = 80 binds for inserts;
 * 2 + 20 = 22 for updates).
 */
function buildTripLineLinkStmts(
  db: D1Database,
  tripId: string,
  lineIds: string[],
  now: string,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const CHUNK = 20;
  for (let j = 0; j < lineIds.length; j += CHUNK) {
    const chunkIds = lineIds.slice(j, j + CHUNK);
    const linkPlaceholders = chunkIds.map(() => "(?, ?, ?, ?)").join(",");
    const linkBinds = chunkIds.flatMap((lineId) => [newUuid(), tripId, lineId, now]);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO business_trip_report_lines
            (id, business_trip_report_id, amex_statement_line_id, created_at)
           VALUES ${linkPlaceholders}`,
        )
        .bind(...linkBinds),
    );
    const idPlaceholders = chunkIds.map(() => "?").join(",");
    stmts.push(
      db
        .prepare(
          `UPDATE amex_statement_lines
           SET business_trip_id = ?, business_trip_status = 'candidate', updated_at = ?
           WHERE id IN (${idPlaceholders})
             AND business_trip_status NOT IN ('confirmed','excluded')`,
        )
        .bind(tripId, now, ...chunkIds),
    );
  }
  return stmts;
}

/** Run a list of prepared statements in chunked batches (D1 caps ~30/batch). */
async function batchWrite(
  db: D1Database,
  stmts: D1PreparedStatement[],
): Promise<void> {
  const CHUNK = 30;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    const slice = stmts.slice(i, i + CHUNK);
    if (slice.length > 0) await db.batch(slice);
  }
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

/**
 * AMEX statement lines linked to each business trip report (via
 * business_trip_report_lines), keyed by report id. Empty map for no ids.
 * Used by the export review page to render the lines behind each trip.
 */
export async function listAmexLinesForBusinessTripReports(
  reportIds: string[],
): Promise<Map<string, AmexStatementLine[]>> {
  const out = new Map<string, AmexStatementLine[]>();
  const unique = [...new Set(reportIds.filter(Boolean))];
  if (unique.length === 0) return out;
  const db = getReceiptsDb();
  for (let i = 0; i < unique.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + D1_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT btrl.business_trip_report_id AS report_id, asl.*
         FROM business_trip_report_lines btrl
         JOIN amex_statement_lines asl ON asl.id = btrl.amex_statement_line_id
         WHERE btrl.business_trip_report_id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<AmexStatementLine & { report_id: string }>();
    for (const row of result.results ?? []) {
      const { report_id, ...line } = row;
      const arr = out.get(report_id) ?? [];
      arr.push(line);
      out.set(report_id, arr);
    }
  }
  return out;
}

// ─── Business trip CRUD + membership (ADR 0010) ──────────────────────────────

export interface BusinessTripWithCounts extends BusinessTripReport {
  line_count: number;
  receipt_count: number;
}

/** All trips with member counts (lines + receipts) via correlated subqueries. */
export async function listBusinessTripsWithCounts(): Promise<BusinessTripWithCounts[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT t.*,
          (SELECT COUNT(*) FROM business_trip_report_lines l
             WHERE l.business_trip_report_id = t.id) AS line_count,
          (SELECT COUNT(*) FROM business_trip_report_receipts r
             WHERE r.business_trip_report_id = t.id) AS receipt_count
       FROM business_trip_reports t
       ORDER BY t.start_date DESC, t.created_at DESC`,
    )
    .all<BusinessTripWithCounts>();
  return result.results ?? [];
}

export interface CreateBusinessTripInput {
  tripName?: string | null;
  startDate: string;
  endDate: string;
  purpose?: string | null;
  primaryLocation?: string | null;
  cardholderName?: string | null;
}

/**
 * Operator-created trip (POST /api/receipts/trips). Born `status='confirmed'`
 * (explicit intent) — detection-created trips stay 'candidate'. cardholder_name
 * is NOT NULL in the schema (0005); an absent cardholder defaults to
 * 'OPERATOR' (the import path always supplies a cardholder).
 */
export async function createBusinessTrip(
  input: CreateBusinessTripInput,
  actor: string,
): Promise<string> {
  const db = getReceiptsDb();
  const id = newUuid();
  const now = nowIso();
  const cardholder = input.cardholderName?.trim() || "OPERATOR";
  await db
    .prepare(
      `INSERT INTO business_trip_reports
        (id, trip_name, cardholder_name, start_date, end_date, primary_location,
         status, purpose, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
    )
    .bind(
      id,
      input.tripName?.trim() || null,
      cardholder,
      input.startDate,
      input.endDate,
      input.primaryLocation?.trim() || null,
      input.purpose?.trim() || null,
      now,
      now,
    )
    .run();

  await createAuditEntry(db, {
    actor,
    action: "business_trip.created",
    objectType: "business_trip",
    objectId: id,
    newValueJson: stringifyJson({ ...input, cardholderName: cardholder, status: "confirmed" }),
  });

  return id;
}

export interface BusinessTripMemberLine {
  id: string;
  transaction_date: string;
  merchant: string;
  amount_minor: number;
  statement_month: string;
  business_trip_status: string;
}

export interface BusinessTripMemberReceipt {
  id: string;
  transaction_date: string | null;
  merchant: string | null;
  amount_minor: number | null;
  status: string;
  payment_path: string;
}

export interface BusinessTripDetail {
  trip: BusinessTripReport | null;
  lines: BusinessTripMemberLine[];
  receipts: BusinessTripMemberReceipt[];
}

export async function getBusinessTripWithMembers(
  id: string,
): Promise<BusinessTripDetail> {
  const db = getReceiptsDb();
  const trip = await db
    .prepare(`SELECT * FROM business_trip_reports WHERE id = ?`)
    .bind(id)
    .first<BusinessTripReport>();

  const lines = await db
    .prepare(
      `SELECT asl.id, asl.transaction_date, asl.merchant, asl.amount_minor,
              asl.statement_month, asl.business_trip_status
       FROM business_trip_report_lines btl
       JOIN amex_statement_lines asl ON asl.id = btl.amex_statement_line_id
       WHERE btl.business_trip_report_id = ?
       ORDER BY asl.transaction_date ASC`,
    )
    .bind(id)
    .all<BusinessTripMemberLine>();

  const receipts = await db
    .prepare(
      `SELECT r.id, r.transaction_date, r.merchant, r.amount_minor, r.status, r.payment_path
       FROM business_trip_report_receipts btr
       JOIN receipt_records r ON r.id = btr.receipt_id
       WHERE btr.business_trip_report_id = ?
       ORDER BY r.transaction_date ASC`,
    )
    .bind(id)
    .all<BusinessTripMemberReceipt>();

  return {
    trip,
    lines: lines.results ?? [],
    receipts: receipts.results ?? [],
  };
}

export interface UpdateBusinessTripInput {
  tripName?: string | null;
  startDate?: string;
  endDate?: string;
  purpose?: string | null;
  primaryLocation?: string | null;
  status?: BusinessTripStatus;
}

/**
 * Edit trip fields and/or transition status (ADR 0010 D4). Status transitions
 * are validated here (defense-in-depth; the route validates first for a clean
 * 409). A confirm/reject transition syncs member lines via the pure
 * computeTripStatusLineUpdates helper. 'exported' is rejected (409 at route).
 */
export async function updateBusinessTrip(
  id: string,
  input: UpdateBusinessTripInput,
  actor: string,
): Promise<BusinessTripStatus> {
  const db = getReceiptsDb();
  const now = nowIso();
  const before = await db
    .prepare(`SELECT * FROM business_trip_reports WHERE id = ?`)
    .bind(id)
    .first<BusinessTripReport>();
  if (!before) throw new Error(`Business trip ${id} not found.`);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("tripName" in input) { sets.push("trip_name = ?"); binds.push(input.tripName?.trim() || null); }
  if ("purpose" in input) { sets.push("purpose = ?"); binds.push(input.purpose?.trim() || null); }
  if ("primaryLocation" in input) { sets.push("primary_location = ?"); binds.push(input.primaryLocation?.trim() || null); }
  if (input.startDate !== undefined) { sets.push("start_date = ?"); binds.push(input.startDate); }
  if (input.endDate !== undefined) { sets.push("end_date = ?"); binds.push(input.endDate); }

  let newStatus: BusinessTripStatus = before.status;
  if (input.status !== undefined && input.status !== before.status) {
    const v = validateTripTransition(before.status, input.status);
    if (!v.ok) throw new Error(v.error ?? "Invalid trip transition.");
    newStatus = input.status;
    sets.push("status = ?");
    binds.push(newStatus);
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    binds.push(now, id);
    await db
      .prepare(`UPDATE business_trip_reports SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();

    const action =
      newStatus !== before.status && newStatus === "confirmed"
        ? "business_trip.confirmed"
        : newStatus !== before.status && newStatus === "rejected"
          ? "business_trip.rejected"
          : "business_trip.updated";
    await createAuditEntry(db, {
      actor,
      action,
      objectType: "business_trip",
      objectId: id,
      oldValueJson: stringifyJson({ status: before.status }),
      newValueJson: stringifyJson(input),
    });
  }

  // Status sync (ADR D4): apply member-line updates on a real transition.
  if (
    newStatus !== before.status &&
    (newStatus === "confirmed" || newStatus === "rejected")
  ) {
    const memberLineIds = await getMemberLineIds(db, id);
    const updates = computeTripStatusLineUpdates(
      id,
      memberLineIds,
      newStatus as TripTransition,
    );
    await applyLineStatusUpdates(db, updates, now);
  }

  return newStatus;
}

async function getMemberLineIds(db: D1Database, tripId: string): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT amex_statement_line_id AS id
       FROM business_trip_report_lines
       WHERE business_trip_report_id = ?`,
    )
    .bind(tripId)
    .all<{ id: string }>();
  return (result.results ?? []).map((r) => r.id);
}

async function applyLineStatusUpdates(
  db: D1Database,
  updates: Array<{
    lineId: string;
    businessTripId: string | null;
    businessTripStatus: string;
  }>,
  now: string,
): Promise<void> {
  // Two bulk UPDATEs split by target status: confirmed keeps business_trip_id
  // (already = tripId from attach); rejected clears it. Chunked for D1's bind
  // ceiling.
  const confirmedIds = updates
    .filter((u) => u.businessTripStatus === "confirmed")
    .map((u) => u.lineId);
  const excludedIds = updates
    .filter((u) => u.businessTripStatus === "excluded")
    .map((u) => u.lineId);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < confirmedIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = confirmedIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    stmts.push(
      db
        .prepare(
          `UPDATE amex_statement_lines SET business_trip_status = 'confirmed', updated_at = ?
           WHERE id IN (${ph})`,
        )
        .bind(now, ...chunk),
    );
  }
  for (let i = 0; i < excludedIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = excludedIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    stmts.push(
      db
        .prepare(
          `UPDATE amex_statement_lines
           SET business_trip_id = NULL, business_trip_status = 'excluded', updated_at = ?
           WHERE id IN (${ph})`,
        )
        .bind(now, ...chunk),
    );
  }
  await batchWrite(db, stmts);
}

export interface TripMemberIds {
  lineIds?: string[];
  receiptIds?: string[];
}

/**
 * Lines in `lineIds` currently claimed by a DIFFERENT trip — the attach route
 * refuses these with a 409 (operator detaches at the owning trip first; no
 * silent moves). Returns [] when all are free or already on this trip.
 */
export async function findCrossTripLineConflicts(
  tripId: string,
  lineIds: string[],
): Promise<Array<{ lineId: string; businessTripId: string }>> {
  if (lineIds.length === 0) return [];
  const db = getReceiptsDb();
  const conflicts: Array<{ lineId: string; businessTripId: string }> = [];
  for (let i = 0; i < lineIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = lineIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT id, business_trip_id
         FROM amex_statement_lines
         WHERE id IN (${ph}) AND business_trip_id IS NOT NULL AND business_trip_id != ?`,
      )
      .bind(...chunk, tripId)
      .all<{ id: string; business_trip_id: string }>();
    for (const row of result.results ?? []) {
      conflicts.push({ lineId: row.id, businessTripId: row.business_trip_id });
    }
  }
  return conflicts;
}

/**
 * Attach lines + receipts to a trip. Lines get business_trip_id + status
 * ('confirmed' if the trip is confirmed, else 'candidate') and a link-table
 * row. Receipts get a link-table row ONLY — receipt rows are never written
 * (ADR D2; sealed receipts are legal members by construction). Cross-trip line
 * conflicts must be checked by the caller (findCrossTripLineConflicts) first.
 */
export async function attachTripMembers(
  tripId: string,
  members: TripMemberIds,
  actor: string,
): Promise<{ lines: number; receipts: number }> {
  const db = getReceiptsDb();
  const now = nowIso();
  const lineIds = (members.lineIds ?? []).filter(Boolean);
  const receiptIds = (members.receiptIds ?? []).filter(Boolean);

  const trip = await db
    .prepare(`SELECT status FROM business_trip_reports WHERE id = ?`)
    .bind(tripId)
    .first<{ status: BusinessTripStatus }>();
  if (!trip) throw new Error(`Business trip ${tripId} not found.`);
  const lineStatus = trip.status === "confirmed" ? "confirmed" : "candidate";

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < lineIds.length; i += 20) {
    const chunk = lineIds.slice(i, i + 20);
    const linkPh = chunk.map(() => "(?, ?, ?, ?)").join(",");
    const linkBinds = chunk.flatMap((lid) => [newUuid(), tripId, lid, now]);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO business_trip_report_lines
            (id, business_trip_report_id, amex_statement_line_id, created_at)
           VALUES ${linkPh}`,
        )
        .bind(...linkBinds),
    );
    const idPh = chunk.map(() => "?").join(",");
    stmts.push(
      db
        .prepare(
          `UPDATE amex_statement_lines
           SET business_trip_id = ?, business_trip_status = ?, updated_at = ?
           WHERE id IN (${idPh})`,
        )
        .bind(tripId, lineStatus, now, ...chunk),
    );
  }
  for (let i = 0; i < receiptIds.length; i += 20) {
    const chunk = receiptIds.slice(i, i + 20);
    const ph = chunk.map(() => "(?, ?, ?, ?)").join(",");
    const binds = chunk.flatMap((rid) => [newUuid(), tripId, rid, now]);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO business_trip_report_receipts
            (id, business_trip_report_id, receipt_id, created_at)
           VALUES ${ph}`,
        )
        .bind(...binds),
    );
  }
  await batchWrite(db, stmts);

  await createAuditEntry(db, {
    actor,
    action: "business_trip.members_changed",
    objectType: "business_trip",
    objectId: tripId,
    newValueJson: stringifyJson({ attach: { lineIds, receiptIds } }),
  });
  return { lines: lineIds.length, receipts: receiptIds.length };
}

/**
 * Detach lines + receipts from a trip. Lines: business_trip_id = NULL, status
 * 'excluded', link row deleted (only for lines claimed by this trip). Receipts:
 * link row deleted. (Receipt rows are never written.)
 */
export async function detachTripMembers(
  tripId: string,
  members: TripMemberIds,
  actor: string,
): Promise<{ lines: number; receipts: number }> {
  const db = getReceiptsDb();
  const now = nowIso();
  const lineIds = (members.lineIds ?? []).filter(Boolean);
  const receiptIds = (members.receiptIds ?? []).filter(Boolean);

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < lineIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = lineIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    stmts.push(
      db
        .prepare(
          `UPDATE amex_statement_lines
           SET business_trip_id = NULL, business_trip_status = 'excluded', updated_at = ?
           WHERE id IN (${ph}) AND business_trip_id = ?`,
        )
        .bind(now, ...chunk, tripId),
    );
    stmts.push(
      db
        .prepare(
          `DELETE FROM business_trip_report_lines
           WHERE business_trip_report_id = ? AND amex_statement_line_id IN (${ph})`,
        )
        .bind(tripId, ...chunk),
    );
  }
  for (let i = 0; i < receiptIds.length; i += D1_ID_CHUNK_SIZE) {
    const chunk = receiptIds.slice(i, i + D1_ID_CHUNK_SIZE);
    const ph = chunk.map(() => "?").join(",");
    stmts.push(
      db
        .prepare(
          `DELETE FROM business_trip_report_receipts
           WHERE business_trip_report_id = ? AND receipt_id IN (${ph})`,
        )
        .bind(tripId, ...chunk),
    );
  }
  await batchWrite(db, stmts);

  await createAuditEntry(db, {
    actor,
    action: "business_trip.members_changed",
    objectType: "business_trip",
    objectId: tripId,
    newValueJson: stringifyJson({ detach: { lineIds, receiptIds } }),
  });
  return { lines: lineIds.length, receipts: receiptIds.length };
}

/** Current member line + receipt ids for a trip (for the picker's exclusion set). */
export async function listTripMemberIds(
  tripId: string,
): Promise<{ lineIds: string[]; receiptIds: string[] }> {
  const db = getReceiptsDb();
  const lines = await db
    .prepare(
      `SELECT amex_statement_line_id AS id FROM business_trip_report_lines WHERE business_trip_report_id = ?`,
    )
    .bind(tripId)
    .all<{ id: string }>();
  const receipts = await db
    .prepare(
      `SELECT receipt_id AS id FROM business_trip_report_receipts WHERE business_trip_report_id = ?`,
    )
    .bind(tripId)
    .all<{ id: string }>();
  return {
    lineIds: (lines.results ?? []).map((r) => r.id),
    receiptIds: (receipts.results ?? []).map((r) => r.id),
  };
}

/**
 * Charges attachable to a trip (ADR 0010 D2 picker). Returns AMEX lines +
 * receipts whose transaction_date falls in `window` (null = all), optionally
 * filtered by merchant `q` (LIKE). Lines carry `ownedByTripId` so the UI can
 * flag a different-trip owner (attach will 409). Does NOT exclude current
 * members of THIS trip — the candidates route applies {@link filterAttachCandidates}
 * for that (pure, tested). Cross-month by construction (the window spans months).
 */
export async function listTripAttachCandidates(
  opts: { window: { start: string; end: string } | null; q: string },
): Promise<CandidateRow[]> {
  const db = getReceiptsDb();
  const hasQ = opts.q.trim().length > 0;
  const qPattern = `%${opts.q.trim()}%`;
  const rows: CandidateRow[] = [];

  const datePred = opts.window ? "transaction_date BETWEEN ? AND ?" : "1=1";

  const lines = await db
    .prepare(
      `SELECT id, transaction_date, merchant, amount_minor, currency,
              statement_month, match_status, business_trip_id, matched_receipt_id
       FROM amex_statement_lines
       WHERE ${datePred} ${hasQ ? "AND merchant LIKE ?" : ""}
       ORDER BY transaction_date ASC`,
    )
    .bind(...(opts.window ? [opts.window.start, opts.window.end] : []), ...(hasQ ? [qPattern] : []))
    .all<{
      id: string;
      transaction_date: string;
      merchant: string;
      amount_minor: number;
      currency: string;
      statement_month: string;
      match_status: string | null;
      business_trip_id: string | null;
      matched_receipt_id: string | null;
    }>();
  for (const l of lines.results ?? []) {
    rows.push({
      kind: "line",
      id: l.id,
      transactionDate: l.transaction_date,
      merchant: l.merchant,
      amountMinor: l.amount_minor,
      currency: l.currency,
      month: l.statement_month,
      status: l.match_status,
      ownedByTripId: l.business_trip_id,
      matchedReceiptId: l.matched_receipt_id,
      paymentPath: null,
    });
  }

  const recs = await db
    .prepare(
      `SELECT id, transaction_date, merchant, amount_minor, currency,
              export_statement_month, status, payment_path
       FROM receipt_records
       WHERE deleted_at IS NULL
         AND ${datePred} ${hasQ ? "AND merchant LIKE ?" : ""}
       ORDER BY transaction_date ASC`,
    )
    .bind(...(opts.window ? [opts.window.start, opts.window.end] : []), ...(hasQ ? [qPattern] : []))
    .all<{
      id: string;
      transaction_date: string | null;
      merchant: string | null;
      amount_minor: number | null;
      currency: string;
      export_statement_month: string | null;
      status: string;
      payment_path: string;
    }>();
  for (const r of recs.results ?? []) {
    rows.push({
      kind: "receipt",
      id: r.id,
      transactionDate: r.transaction_date,
      merchant: r.merchant,
      amountMinor: r.amount_minor,
      currency: r.currency,
      month:
        r.export_statement_month ??
        (r.transaction_date ? r.transaction_date.slice(0, 7) : null),
      status: r.status,
      ownedByTripId: null,
      matchedReceiptId: null,
      paymentPath: r.payment_path,
    });
  }

  // Mixed sort by transactionDate (nulls last).
  rows.sort((a, b) =>
    (a.transactionDate ?? "9999-99-99").localeCompare(b.transactionDate ?? "9999-99-99"),
  );
  return rows;
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

  // Prefer reusing a pending draft. If there's no draft but a finalized
  // export already exists for the month, callers must explicitly request a
  // revision via createExportRevision().
  const draft = await db
    .prepare(
      `SELECT id FROM receipt_exports
       WHERE export_month = ? AND status = 'draft'
       ORDER BY COALESCE(export_revision, 1) DESC LIMIT 1`,
    )
    .bind(month)
    .first<{ id: string }>();
  if (draft) return draft.id;

  const finalized = await db
    .prepare(
      `SELECT id FROM receipt_exports
       WHERE export_month = ? AND status = 'finalized' LIMIT 1`,
    )
    .bind(month)
    .first<{ id: string }>();
  if (finalized) {
    throw new Error(
      `Export for ${month} is already finalized. POST /api/receipts/export/${month}?correction=true to create a revision.`,
    );
  }

  const id = newUuid();
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO receipt_exports
        (id, export_month, status, created_by, created_at, retention_until, legal_hold)
       VALUES (?, ?, 'draft', ?, ?, ?, 1)`,
    )
    .bind(id, month, actor, now, retentionUntilIso(now))
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
  // Return the highest-revision row for this month. Drafts and finalized
  // exports coexist in the table once revisions are introduced.
  return db
    .prepare(
      `SELECT * FROM receipt_exports
       WHERE export_month = ?
       ORDER BY COALESCE(export_revision, 1) DESC, created_at DESC
       LIMIT 1`,
    )
    .bind(month)
    .first<ReceiptExport>();
}

/**
 * Latest FINALIZED export for a month (highest revision), or null.
 *
 * Distinct from {@link getExport} (which returns the highest-revision row
 * regardless of status): when a revision draft is open, getExport returns the
 * DRAFT, but the sealed package the operator/accountant should download is the
 * latest FINALIZED revision. The download route's default path uses this so an
 * open draft never makes the sealed package undownloadable (the mid-revision
 * gap: getExport returning the draft caused a 409 on the sealed rev-N package).
 */
export async function getLatestFinalizedExport(
  month: string,
): Promise<ReceiptExport | null> {
  const db = getReceiptsDb();
  return db
    .prepare(
      `SELECT * FROM receipt_exports
       WHERE export_month = ? AND status = 'finalized'
       ORDER BY COALESCE(export_revision, 1) DESC, created_at DESC
       LIMIT 1`,
    )
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

// ─── receipt_export_items ───────────────────────────────────────────────────
// Per-bundle audit trail of which receipts and AMEX lines shipped in each
// export (migration 0017). Populated at bundle-build time, consulted by
// finalizeExport to mark receipts status='exported' and by the cross-month
// finalize gate. Replaced on rebuild — the partial unique index on
// (export_id, item_type, item_id) makes this idempotent per-export.

/**
 * Replace the item set for an export. Deletes existing rows for the
 * export then inserts the new set. Caller must ensure exportId exists.
 */
export async function replaceExportItems(
  exportId: string,
  items: Array<{ itemType: "receipt" | "amex_line"; itemId: string }>,
): Promise<void> {
  const db = getReceiptsDb();
  const now = nowIso();
  await db
    .prepare(`DELETE FROM receipt_export_items WHERE export_id = ?`)
    .bind(exportId)
    .run();
  if (items.length === 0) return;
  // Batch via db.batch for a single transaction.
  const stmts = items.map((it) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO receipt_export_items
          (id, export_id, item_type, item_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(newUuid(), exportId, it.itemType, it.itemId, now),
  );
  // D1 limits batches to ~30 statements; chunk to stay safe.
  const CHUNK = 30;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await db.batch(stmts.slice(i, i + CHUNK));
  }
}

/**
 * Receipt IDs that shipped in the given export. Used by finalizeExport to
 * mark receipts status='exported' (audit A5).
 */
export async function listReceiptIdsForExport(
  exportId: string,
): Promise<string[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT item_id FROM receipt_export_items
       WHERE export_id = ? AND item_type = 'receipt'
       ORDER BY created_at ASC`,
    )
    .bind(exportId)
    .all<{ item_id: string }>();
  return (result.results ?? []).map((r) => r.item_id);
}

/**
 * Export IDs whose bundle included a given receipt. Reverse-lookup used by
 * audit / future "is this receipt already exported" surfaces.
 */
export async function listExportsContainingReceipt(
  receiptId: string,
): Promise<string[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT DISTINCT export_id FROM receipt_export_items
       WHERE item_type = 'receipt' AND item_id = ?`,
    )
    .bind(receiptId)
    .all<{ export_id: string }>();
  return (result.results ?? []).map((r) => r.export_id);
}

/**
 * Persist the staged-bundle metadata onto a draft row: the R2 keys, the
 * archive + manifest SHA-256s, and bundle_built_at (when the bundle was
 * last (re)built). Shared between the rebuild path (POST
 * /api/receipts/export/month with finalize=false) and finalizeExport so a
 * draft built via the rebuild route carries the same persisted fields the
 * finalize-only route (/api/receipts/export/[month]) checks before
 * finalizing — without it, Rebuild→Finalize always 400s with
 * "Export bundle has not been generated yet."
 *
 * Guarded on status='draft' so a finalized row is left untouched, matching
 * finalizeExport's own guard (callers already reject finalized months with a
 * 409 before reaching here). This also keeps the no-op-on-finalized behavior
 * intact: if the row is already finalized, nothing is written.
 */
export async function recordExportBundle(
  exportId: string,
  archiveR2Key: string,
  manifestR2Key: string,
  archiveSha256: string,
  // The sealed-bundle params are REQUIRED (nullable, not optional). TS forbids
  // a required param after an optional one, so making paymentDueDate +
  // operatorMessage required (the Phase B P1 fix) promotes these too. More
  // importantly it is correct: this UPDATE re-writes sealed columns, so an
  // omitted value would bind `?? null` and overwrite a correct one — requiring
  // the value (null is still allowed) makes omission a compile error.
  manifestSha256: string | null,
  proofsR2Key: string | null,
  proofsSha256: string | null,
  /** AMEX payment-due date to snapshot onto this revision (0035). The build
   *  path passes the just-fetched artifact date; finalizeExport passes the
   *  draft row's existing snapshot (a no-op re-write of the same value).
   *
   *  REQUIRED (nullable, not optional): this UPDATE re-writes the sealed bundle
   *  columns, so an omitted value binds as `?? null` and OVERWRITES a correct
   *  value written moments earlier in the same request. Making the param
   *  required turns omission into a compile error rather than a silent null —
   *  the Phase B P1 fix (the one-shot finalize path was nulling both columns). */
  paymentDueDate: string | null,
  /** Operator free-text message for the month (0037). One stored value, two
   *  surfaces (O7): the build passes it so the pack notice carries it inside
   *  the sealed ZIP; finalizeExport re-writes the draft's existing value.
   *  Sealed with the row by the WHERE status='draft' guard below — mutating it
   *  post-seal requires a rebuild (new revision), same doctrine as every other
   *  sealed value (ADR 0009). The O7 preflight check (19th) verifies the
   *  notice's 【今月のご連絡】 matches this stored value at send time.
   *
   *  REQUIRED (nullable) for the same reason as paymentDueDate.
   *
   *  NOTE: this writes operator_message (the VALUE — O7 needs it sealed into the
   *  bytes) but deliberately does NOT write operator_message_updated_at. That
   *  timestamp is the message-DECISION signal (NULL = the operator never decided
   *  ⇒ the message_not_reviewed finalize blocker); only updateExportOperatorMessage
   *  (an explicit save / "no message") sets it. message_stale still clears on
   *  rebuild because bundle_built_at advances past the save timestamp. */
  operatorMessage: string | null,
): Promise<void> {
  const db = getReceiptsDb();
  const now = nowIso();
  await db
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
           operator_message = ?
       WHERE id = ? AND status = 'draft'`,
    )
    .bind(
      archiveR2Key,
      manifestR2Key,
      archiveSha256,
      manifestSha256 ?? null,
      proofsR2Key ?? null,
      proofsSha256 ?? null,
      now,
      paymentDueDate ?? null,
      operatorMessage ?? null,
      exportId,
    )
    .run();
}

/**
 * Update ONLY operator_message on an open draft revision (E1 — the editable
 * preface). Deliberately touches no other column: it must NOT advance
 * bundle_built_at (that would mask the staleness the finalize gate detects —
 * E3) and must not re-write the sealed bundle columns the way recordExportBundle
 * does. The WHERE status='draft' guard means a sealed month is never mutated;
 * the PATCH /message caller checks for an open draft first and 409s otherwise,
 * so this update should always match exactly one draft row. Trim + the 2000-char
 * cap are applied by the caller; null clears the column (buildPackNotice then
 * omits the whole 【今月のご連絡】 heading).
 *
 * After the 2026-06 message-loss incident: this is the ONLY writer of
 * operator_message_updated_at (the message-DECISION timestamp; recordExportBundle
 * no longer touches it). So a successful return here is the single signal that
 * the operator made a message decision (save text, or "no message" with a NULL
 * value) — which clears the message_not_reviewed finalize blocker.
 *
 * A2 hardening: a D1 UPDATE matching zero rows is an ERROR, not a silent 200.
 * The 2026-06 loss was hard to diagnose in part because a no-op write would have
 * returned success; now this throws, the PATCH route surfaces a 500, and the
 * "saved" indicator never lies. The caller's draft check makes 0 rows a race
 * (draft sealed between read and write), not normal flow.
 */
export async function updateExportOperatorMessage(
  exportId: string,
  operatorMessage: string | null,
): Promise<{ rowsWritten: number }> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `UPDATE receipt_exports
       SET operator_message = ?,
           operator_message_updated_at = ?
       WHERE id = ? AND status = 'draft'`,
    )
    .bind(operatorMessage, nowIso(), exportId)
    .run();
  const rowsWritten = result.meta?.changes ?? 0;
  assertExactlyOneRowWritten(rowsWritten, `updateExportOperatorMessage(${exportId})`);
  return { rowsWritten };
}

export async function finalizeExport(
  exportId: string,
  archiveR2Key: string,
  manifestR2Key: string,
  archiveSha256: string,
  actor: string,
  // Sealed-bundle params REQUIRED (nullable) — see recordExportBundle. The
  // one-shot finalize path passes the just-fetched values; the two-step path
  // passes the draft row's stored snapshots.
  manifestSha256: string | null,
  proofsR2Key: string | null,
  proofsSha256: string | null,
  /** AMEX payment-due date snapshot for this revision (0035); the caller passes
   *  the draft row's existing value so the finalize re-stage writes the same
   *  date the build captured. REQUIRED (nullable, not optional) — see
   *  recordExportBundle. The one-shot finalize path (export/month/route.ts)
   *  passes the just-fetched artifact date; the two-step path
   *  (export/[month]/route.ts) passes the draft row's stored snapshot. */
  paymentDueDate: string | null,
  /** Operator message re-written from the draft row's stored value (0037).
   *  REQUIRED (nullable) — see recordExportBundle. */
  operatorMessage: string | null,
): Promise<void> {
  const db = getReceiptsDb();
  const now = nowIso();

  // Record the staged bundle (R2 keys + SHAs + bundle_built_at) via the
  // shared helper so the finalize:true path leaves the same persisted bundle
  // metadata as the rebuild path. The UPDATE below flips only the
  // finalize-specific fields — each column is written exactly once (no
  // double-write) and the end-state is identical to the pre-refactor single
  // UPDATE, plus the new bundle_built_at column.
  await recordExportBundle(
    exportId,
    archiveR2Key,
    manifestR2Key,
    archiveSha256,
    manifestSha256,
    proofsR2Key,
    proofsSha256,
    paymentDueDate,
    operatorMessage,
  );

  const result = await db
    .prepare(
      `UPDATE receipt_exports
       SET status = 'finalized',
           finalization_hash = ?,
           finalized_by = ?,
           finalized_at = ?
       WHERE id = ? AND status = 'draft'`,
    )
    .bind(manifestSha256 ?? archiveSha256, actor, now, exportId)
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
    newValueJson: stringifyJson({
      archiveR2Key,
      archiveSha256,
      manifestSha256: manifestSha256 ?? null,
      proofsR2Key: proofsR2Key ?? null,
      proofsSha256: proofsSha256 ?? null,
    }),
  });

  // A5 lifecycle: mark every receipt that shipped in this bundle as
  // status='exported' and exported_month=<the export's month>. Both
  // columns already existed but were dead before receipt_export_items
  // gave finalizeExport a row set to act on. Audit-log each promotion so
  // the receipt's lifecycle trail explains why it's no longer editable.
  //
  // Idempotent across re-runs only because finalizeExport itself refuses
  // to run twice (status='draft' guard above). Re-entering here after a
  // partial failure would re-UPDATE the same rows harmlessly.
  const exportRow = await db
    .prepare(`SELECT export_month FROM receipt_exports WHERE id = ?`)
    .bind(exportId)
    .first<{ export_month: string }>();
  const exportMonth = exportRow?.export_month;
  if (exportMonth) {
    const exportedReceiptIds = await listReceiptIdsForExport(exportId);
    if (exportedReceiptIds.length > 0) {
      // Promote status + stamp exported_month. The status CHECK constraint
      // allows 'exported'. We do NOT touch 'archived' rows — once archived
      // the lifecycle is terminal and a re-finalize shouldn't unwind it.
      // Chunk to respect D1's parameter limit per statement. This query binds
      // two fixed values (exportMonth, now) plus the ID list, so a full 90-ID
      // chunk uses 92 of D1's 100-bind ceiling — within the ten-slot headroom.
      for (let i = 0; i < exportedReceiptIds.length; i += D1_ID_CHUNK_SIZE) {
        const chunk = exportedReceiptIds.slice(i, i + D1_ID_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        await db
          .prepare(
            `UPDATE receipt_records
               SET status = 'exported',
                   exported_month = ?,
                   updated_at = ?
             WHERE id IN (${placeholders})
               AND status IN ('captured','needs_review','reviewed','reconciled')`,
          )
          .bind(exportMonth, now, ...chunk)
          .run();
      }
      for (const receiptId of exportedReceiptIds) {
        await createAuditEntry(db, {
          actor,
          action: "receipt.exported",
          objectType: "receipt",
          objectId: receiptId,
          newValueJson: stringifyJson({ exportId, exportedMonth: exportMonth }),
        });
      }
    }
  }
}

// ─── Delivery records (Phase B; 0036_export_deliveries) ──────────────────────
// One row per HTTP send attempt to Resend. State transitions and idempotency
// logic live in lib/receipts/delivery-state.ts (pure, unit-tested); these are
// the thin D1 wrappers. Every write that changes an attempt's state updates
// the denormalised receipt_exports.delivery_state IN THE SAME D1 batch
// (transaction), so list queries never disagree with the attempt history.
// A failed send never touches the seal — only the month's delivery_state.

/** Input for a new delivery attempt row (state starts 'pending'). */
export interface CreateDeliveryInput {
  exportId: string;
  attemptId: string;
  idempotencyKey: string;
  toAddress: string;
  ccAddress: string | null;
  subject: string;
  body: string;
  operatorMessage: string | null;
  zipFilename: string;
  zipSha256: string;
  zipBytes: number;
}

/**
 * Record a new send attempt (state 'pending') and set the export's
 * delivery_state='pending' in one transaction. Returns the new delivery id.
 */
export async function createDelivery(input: CreateDeliveryInput): Promise<string> {
  const db = getReceiptsDb();
  const id = newUuid();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO export_deliveries
          (id, export_id, attempt_id, idempotency_key, state,
           to_address, cc_address, subject, body, operator_message,
           zip_filename, zip_sha256, zip_bytes, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.exportId,
        input.attemptId,
        input.idempotencyKey,
        input.toAddress,
        input.ccAddress,
        input.subject,
        input.body,
        input.operatorMessage,
        input.zipFilename,
        input.zipSha256,
        input.zipBytes,
        now,
      ),
    db
      .prepare(`UPDATE receipt_exports SET delivery_state = 'pending' WHERE id = ?`)
      .bind(input.exportId),
  ]);
  return id;
}

/** One delivery attempt by id. */
export async function getDelivery(id: string): Promise<ExportDelivery | null> {
  const db = getReceiptsDb();
  return db
    .prepare(`SELECT * FROM export_deliveries WHERE id = ?`)
    .bind(id)
    .first<ExportDelivery>();
}

/** All delivery attempts for an export, oldest-first (attempt history). */
export async function listDeliveriesForExport(
  exportId: string,
): Promise<ExportDelivery[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT * FROM export_deliveries WHERE export_id = ? ORDER BY created_at ASC`,
    )
    .bind(exportId)
    .all<ExportDelivery>();
  return result.results ?? [];
}

/**
 * All delivery attempts for a month (across its export revisions), oldest-
 * first. Used to derive the month's delivery state and to check the double-
 * send guard (D6) — keyed on the month (yyyymm), not the revision.
 */
export async function listDeliveriesForMonth(
  month: string,
): Promise<ExportDelivery[]> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT d.*
       FROM export_deliveries d
       JOIN receipt_exports e ON e.id = d.export_id
       WHERE e.export_month = ?
       ORDER BY d.created_at ASC`,
    )
    .bind(month)
    .all<ExportDelivery>();
  return result.results ?? [];
}

/**
 * Mark an attempt sent: record the provider message id + completion time, and
 * set the export's delivery_state='delivered' in one transaction. A sent
 * attempt closes the month for reporting.
 */
export async function markDeliverySent(
  id: string,
  providerMessageId: string,
): Promise<void> {
  const db = getReceiptsDb();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE export_deliveries
         SET state = 'sent', provider_message_id = ?, completed_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .bind(providerMessageId, now, id),
    db
      .prepare(
        `UPDATE receipt_exports
         SET delivery_state = 'delivered'
         WHERE id = (SELECT export_id FROM export_deliveries WHERE id = ?)`,
      )
      .bind(id),
  ]);
}

/**
 * Mark an attempt failed: record the error + completion time, and set the
 * export's delivery_state='sealed_undelivered' (retryable; month NOT closed)
 * in one transaction. The seal is untouched — only the reporting state moves.
 */
export async function markDeliveryFailed(id: string, error: string): Promise<void> {
  const db = getReceiptsDb();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE export_deliveries
         SET state = 'failed', error = ?, completed_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .bind(error, now, id),
    db
      .prepare(
        `UPDATE receipt_exports
         SET delivery_state = 'sealed_undelivered'
         WHERE id = (SELECT export_id FROM export_deliveries WHERE id = ?)`,
      )
      .bind(id),
  ]);
}

/**
 * Mark an attempt ambiguously failed: a definitive result was NOT obtained
 * (timeout / network / Resend 5xx — the mail may have been accepted). The
 * attempt stays RESUMABLE (a retry reuses its attempt_id ⇒ same key ⇒ Resend
 * deduplicates), and the month's delivery_state is sealed_undelivered (not
 * closed). The seal is untouched. Counterpart to {@link markDeliveryFailed}
 * (which is for definitive 4xx rejections, terminal). */
export async function markDeliveryAmbiguous(id: string, error: string): Promise<void> {
  const db = getReceiptsDb();
  const now = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE export_deliveries
         SET state = 'ambiguous', error = ?, completed_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .bind(error, now, id),
    db
      .prepare(
        `UPDATE receipt_exports
         SET delivery_state = 'sealed_undelivered'
         WHERE id = (SELECT export_id FROM export_deliveries WHERE id = ?)`,
      )
      .bind(id),
  ]);
}

/**
 * Create a new revision of a previously-finalized export. The prior export
 * row and its R2 archive are untouched — preservation principle.
 */
export async function createExportRevision(
  month: string,
  correctionReason: string,
  actor: string,
): Promise<{ exportId: string; revision: number; supersedesExportId: string }> {
  const db = getReceiptsDb();
  const now = nowIso();

  const prior = await db
    .prepare(
      `SELECT id, export_revision FROM receipt_exports
       WHERE export_month = ? AND status = 'finalized'
       ORDER BY COALESCE(export_revision, 1) DESC LIMIT 1`,
    )
    .bind(month)
    .first<{ id: string; export_revision: number | null }>();

  if (!prior) {
    throw new Error(
      `Cannot create a revision: no finalized export exists for ${month}.`,
    );
  }

  const newRevision = (prior.export_revision ?? 1) + 1;
  const id = newUuid();

  await db
    .prepare(
      `INSERT INTO receipt_exports
        (id, export_month, status, created_by, created_at,
         export_revision, supersedes_export_id, correction_reason,
         retention_until, legal_hold)
       VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      id,
      month,
      actor,
      now,
      newRevision,
      prior.id,
      correctionReason,
      retentionUntilIso(now),
    )
    .run();

  await createAuditEntry(db, {
    actor,
    action: "export.revision_created",
    objectType: "export",
    objectId: id,
    oldValueJson: stringifyJson({ supersedes: prior.id, revision: prior.export_revision ?? 1 }),
    newValueJson: stringifyJson({ revision: newRevision, correctionReason, month }),
  });

  return { exportId: id, revision: newRevision, supersedesExportId: prior.id };
}

// ─── Reconciliation signoff ────────────────────────────────────────────────

export async function rejectIfFinalized(db: D1Database, month: string): Promise<void> {
  const finalized = await db
    .prepare(
      `SELECT id FROM amex_reconciliations WHERE statement_month = ? AND status = 'finalized' LIMIT 1`,
    )
    .bind(month)
    .first<{ id: string }>();
  if (finalized) {
    throw new Error(`Reconciliation for ${month} is finalized`);
  }
}

export async function getFinalizedReconciliationForMonth(
  month: string,
): Promise<AmexReconciliation | null> {
  const db = getReceiptsDb();
  return db
    .prepare(
      `SELECT * FROM amex_reconciliations WHERE statement_month = ? AND status = 'finalized' LIMIT 1`,
    )
    .bind(month)
    .first<AmexReconciliation>();
}

export async function getReconciliationForMonth(
  month: string,
): Promise<AmexReconciliation | null> {
  const db = getReceiptsDb();
  return db
    .prepare(
      `SELECT * FROM amex_reconciliations WHERE statement_month = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(month)
    .first<AmexReconciliation>();
}

export async function listReconciliationStatusByMonth(): Promise<
  Map<string, "draft" | "finalized">
> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT statement_month, status FROM amex_reconciliations
       WHERE status = 'finalized'
       UNION
       SELECT statement_month, MAX(status) AS status FROM amex_reconciliations
       WHERE status = 'draft'
       GROUP BY statement_month`,
    )
    .all<{ statement_month: string; status: "draft" | "finalized" }>();
  const map = new Map<string, "draft" | "finalized">();
  for (const r of result.results ?? []) {
    const prev = map.get(r.statement_month);
    if (prev === "finalized") continue;
    map.set(r.statement_month, r.status);
  }
  return map;
}

export async function listAmexLineCountsByMonth(): Promise<
  Map<string, { total: number; confirmed: number; unmatched: number; noReceipt: number }>
> {
  const db = getReceiptsDb();
  const result = await db
    .prepare(
      `SELECT statement_month,
              COUNT(*) AS total,
              SUM(CASE WHEN match_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
              SUM(CASE WHEN match_status IN ('unmatched','matched') THEN 1 ELSE 0 END) AS unmatched,
              SUM(CASE WHEN match_status = 'no_receipt' THEN 1 ELSE 0 END) AS noReceipt
       FROM amex_statement_lines
       GROUP BY statement_month`,
    )
    .all<{
      statement_month: string;
      total: number;
      confirmed: number;
      unmatched: number;
      noReceipt: number;
    }>();
  const map = new Map<
    string,
    { total: number; confirmed: number; unmatched: number; noReceipt: number }
  >();
  for (const r of result.results ?? []) {
    map.set(r.statement_month, {
      total: r.total,
      confirmed: r.confirmed,
      unmatched: r.unmatched,
      noReceipt: r.noReceipt,
    });
  }
  return map;
}

export async function createReconciliationDraft(
  month: string,
  lineCount: number,
  matchedCount: number,
  noReceiptCount: number,
  actor: string,
  artifactId: string | null,
): Promise<string> {
  const db = getReceiptsDb();
  const id = newUuid();
  const now = nowIso();

  // Clear any stale draft rows left by a previous failed sign-off attempt.
  await db
    .prepare(`DELETE FROM amex_reconciliations WHERE statement_month = ? AND status = 'draft'`)
    .bind(month)
    .run();

  await db
    .prepare(
      `INSERT INTO amex_reconciliations
        (id, statement_month, statement_artifact_id, status, line_count, matched_count, no_receipt_count, created_by, created_at, retention_until, legal_hold)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      id,
      month,
      artifactId,
      lineCount,
      matchedCount,
      noReceiptCount,
      actor,
      now,
      retentionUntilIso(now),
    )
    .run();

  return id;
}

export async function deleteDraftReconciliation(id: string): Promise<void> {
  const db = getReceiptsDb();
  await db
    .prepare(`DELETE FROM amex_reconciliations WHERE id = ? AND status = 'draft'`)
    .bind(id)
    .run();
}

export async function finalizeReconciliation(
  reconciliationId: string,
  manifestR2Key: string,
  manifestSha256: string,
  actor: string,
): Promise<void> {
  const db = getReceiptsDb();

  // Audit finding A2: previously, a race-loser request left a draft row
  // in amex_reconciliations and the catch path deleted it via a separate
  // D1 call wrapped in .catch(() => {}) — silent drift if that delete
  // failed. Now the cleanup is atomic with the finalize UPDATE via
  // db.batch (single transaction): if the UPDATE changes 0 rows (race
  // lost), the DELETE in the same batch removes this request's draft.
  // If the UPDATE succeeds (1 row changed), the DELETE matches 0 rows
  // (status is now 'finalized') and is a no-op.
  const updateStmt = db
    .prepare(
      `UPDATE amex_reconciliations
       SET status = 'finalized',
           manifest_r2_key = ?,
           manifest_sha256 = ?,
           finalized_by = ?,
           finalized_at = ?
       WHERE id = ? AND status = 'draft'`,
    )
    .bind(manifestR2Key, manifestSha256, actor, nowIso(), reconciliationId);

  const cleanupStmt = db
    .prepare(
      `DELETE FROM amex_reconciliations WHERE id = ? AND status = 'draft'`,
    )
    .bind(reconciliationId);

  const results = await db.batch([updateStmt, cleanupStmt]);
  const updateResult = results[0];

  if ((updateResult?.meta.changes ?? 0) === 0) {
    throw new Error(
      `Reconciliation ${reconciliationId} could not be finalized — it may already be finalized or not found.`,
    );
  }

  await createAuditEntry(db, {
    actor,
    action: "amex.reconciliation_signed_off",
    objectType: "amex_reconciliation",
    objectId: reconciliationId,
    newValueJson: stringifyJson({ manifestR2Key, manifestSha256 }),
  });
}

// Reverse a finalized AMEX reconciliation back to 'draft' so receipts in the
// statement month become editable again. Minimal beta-review reopen (operator
// decision 2026-07-20) — not the full ADR 0009 audited-reopen machinery.
// `createReconciliationDraft` already deletes any stale 'draft' row for the
// month before inserting a fresh one, so the row this leaves behind is
// harmlessly replaced whenever the operator re-runs the normal finalize flow.
//
// `db` is an optional testability seam (matches the email-intake /
// crm-reply-monitor / month-lock pattern); production callers omit it and the
// default binding resolves exactly as finalizeReconciliation does.
export async function unfinalizeReconciliation(
  statementMonth: string,
  actor: string,
  reason: string,
  db: D1Database = getReceiptsDb(),
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT id FROM amex_reconciliations WHERE statement_month = ? AND status = 'finalized' LIMIT 1`,
    )
    .bind(statementMonth)
    .first<{ id: string }>();
  if (!row) {
    throw new Error(`No finalized reconciliation found for ${statementMonth}.`);
  }
  await db
    .prepare(
      `UPDATE amex_reconciliations
       SET status = 'draft', finalized_by = NULL, finalized_at = NULL
       WHERE id = ?`,
    )
    .bind(row.id)
    .run();
  await createAuditEntry(db, {
    actor,
    action: "amex.reconciliation_amended",
    objectType: "amex_reconciliation",
    objectId: row.id,
    newValueJson: stringifyJson({ reason, statementMonth, unfinalized: true }),
  });
}
