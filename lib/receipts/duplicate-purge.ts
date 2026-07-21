// Operator-confirmed duplicate PURGE service (audit 2026-07-21, spec C/E/F +
// correction §2/§4/§5/§6/§7).
//
// Permanently removes confirmed duplicate receipts: D1 rows + references + R2
// objects, retaining the canonical receipt as the accounting record. NOT the
// ordinary soft-delete path.
//
// Server is authoritative and revalidates EVERY predicate from D1. Client scores
// are never trusted. Selection is explicit (operator checks each target); the
// recommendation is advisory only.
//
// Atomicity (correction §4/§5): the full request is prefetched/validated before
// any mutation; if ANY target is ineligible, NOTHING is changed. All D1
// reference transfers + deletions + tombstones for ALL selected targets are one
// atomic db.batch(). A SQLite trigger (migration 0032) RAISE(ROLLBACK)s the
// entire batch if any target or the retained row changed between preflight and
// delete — a true write-time guard, not a post-hoc changes() check. R2 cleanup
// runs only after the D1 batch commits and is independently retryable.
//
// Bindings are injected so destructive paths unit-test with mocked D1/R2.

import { nowIso, newUuid } from "@/lib/receipts/db-utils";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import { requiresAttendees } from "@/lib/receipts/categories";
import { findAmexDuplicateCandidates } from "@/lib/receipts/amex-duplicates";
import {
  assessSelection,
  type DuplicateMemberInput,
} from "@/lib/receipts/duplicate-resolution-policy";
import type { ReceiptRecord } from "@/lib/receipts/types";

// ─── types ──────────────────────────────────────────────────────────────────

export type R2BucketName = "RECEIPTS_BUCKET" | "RECEIPTS_ARCHIVE_BUCKET";

export interface R2KeyRef {
  bucket: R2BucketName;
  key: string;
}

export interface PurgeTargetInput {
  receiptId: string;
  expectedUpdatedAt: string;
}

export interface PurgeRequest {
  db: D1Database;
  receiptsBucket: R2Bucket;
  archiveBucket: R2Bucket;
  retainedReceiptId: string;
  retainedExpectedUpdatedAt: string;
  targets: PurgeTargetInput[];
  visualConfirmed: boolean;
  legalHoldExceptionAcknowledged: boolean;
  /** Must equal `PURGE <target-count>`. */
  confirmationText: string;
  reason: string;
  actor: string;
}

/** Hard cap on cluster/target size (correction §2). Small, documented. */
export const PURGE_TARGET_CAP = 10;

export type PurgeFailureStatus = 400 | 404 | 409 | 422;

export class PurgeEligibilityError extends Error {
  constructor(
    public status: PurgeFailureStatus,
    message: string,
  ) {
    super(message);
    this.name = "PurgeEligibilityError";
  }
}

export interface PurgedTargetResult {
  receiptId: string;
  purgeJobId: string;
  status: "completed" | "storage_failed";
  strength: "strong" | "near";
  objectCount: number;
  /** 0 for completed; actual unverifiable/remaining count for storage_failed. */
  remainingKeys: number;
  originalSha256: string | null;
  errorText: string | null;
}

export interface PurgeResult {
  completed: boolean;
  targets: PurgedTargetResult[];
}

const PRE_RECON_STATUSES = ["captured", "needs_review", "reviewed"];

// ─── R2 bucket mapping (correction §7) ──────────────────────────────────────

/**
 * Map a receipt_files.r2_bucket manifest value to a binding name. The manifest
 * stores logical names 'receipts' / 'archive' (and historically the binding
 * names 'dazbeez-receipts' / 'dazbeez-receipts-archive'). Unknown values return
 * null → the caller must reject before any mutation; never silently default to
 * the live bucket.
 */
export function mapBucketName(name: string): R2BucketName | null {
  switch (name) {
    case "receipts":
    case "dazbeez-receipts":
    case "RECEIPTS_BUCKET":
      return "RECEIPTS_BUCKET";
    case "archive":
    case "dazbeez-receipts-archive":
    case "RECEIPTS_ARCHIVE_BUCKET":
      return "RECEIPTS_ARCHIVE_BUCKET";
    default:
      return null;
  }
}

/** Parse a pending_keys_json inventory. Returns null if malformed (never []). */
export function parsePendingKeys(json: string | null): R2KeyRef[] | null {
  if (json == null || json === "") return null;
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out: R2KeyRef[] = [];
  for (const entry of arr) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { key?: unknown }).key !== "string" ||
      (entry as { key: string }).key.length === 0 ||
      typeof (entry as { bucket?: unknown }).bucket !== "string"
    ) {
      return null;
    }
    const bucket = mapBucketName((entry as { bucket: string }).bucket);
    if (bucket === null) return null;
    out.push({ bucket, key: (entry as { key: string }).key });
  }
  return out;
}

// ─── shared assessment loader (correction §3) ───────────────────────────────

export interface MemberAssessmentRecord {
  input: DuplicateMemberInput;
  row: ReceiptRecord;
  attendees: string[];
  amexClaim: { month: string; lineId: string } | null;
  amexClaimCount: number;
  exportItemsCount: number;
  exportMonths: string[];
  businessTripIds: string[];
  emailIntakePromoted: boolean;
  hasProofFile: boolean;
}

function buildInput(
  row: ReceiptRecord,
  signals: {
    claimedByConfirmedAmexLine: boolean;
    businessTripLinked: boolean;
    emailIntakePromoted: boolean;
    attendeesCount: number;
    hasProofFile: boolean;
    exported: boolean;
  },
): DuplicateMemberInput {
  return {
    id: row.id,
    captured_at: row.captured_at,
    updated_at: row.updated_at,
    status: row.status,
    exported: signals.exported,
    archived: row.status === "archived",
    claimedByConfirmedAmexLine: signals.claimedByConfirmedAmexLine,
    businessTripLinked: signals.businessTripLinked,
    emailIntakePromoted: signals.emailIntakePromoted,
    transaction_date: row.transaction_date,
    merchant: row.merchant,
    amount_minor: row.amount_minor,
    currency: row.currency,
    expense_category_code: row.expense_category_code,
    business_purpose: row.business_purpose,
    tax_amount_minor: row.tax_amount_minor,
    tax_rate: row.tax_rate ?? null,
    invoice_registration_number: row.invoice_registration_number ?? null,
    qualified_invoice_status: row.qualified_invoice_status ?? null,
    counterparty_name: row.counterparty_name ?? null,
    // Category-driven attendee requirement (correction §3) — never hardcoded.
    attendeesRequired: requiresAttendees(row.expense_category_code),
    attendeesCount: signals.attendeesCount,
    extractionState: row.extraction_state ?? null,
    hasOriginalFile: Boolean(row.original_r2_key),
    hasProofFile: signals.hasProofFile,
  };
}

/**
 * ONE authoritative loader shared by the cluster preview and purge validation
 * (correction §3). Loads every signal: AMEX claims, export_items membership,
 * archived/exported/reconciled status, business-trip links, email-intake
 * promotion, attendees (+ category-driven requirement), proof/original-file
 * presence, and all accounting fields.
 */
export async function fetchMemberAssessment(
  db: D1Database,
  id: string,
): Promise<MemberAssessmentRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM receipt_records WHERE id = ?`)
    .bind(id)
    .first<ReceiptRecord>();
  if (!row || row.deleted_at) return null;

  const claim = await db
    .prepare(`SELECT statement_month, id FROM amex_statement_lines WHERE matched_receipt_id = ? AND match_status IN ('matched','confirmed') LIMIT 1`)
    .bind(id)
    .first<{ statement_month: string; id: string }>();
  const claimCount = await db
    .prepare(`SELECT COUNT(*) AS n FROM amex_statement_lines WHERE matched_receipt_id = ? AND match_status IN ('matched','confirmed')`)
    .bind(id)
    .first<{ n: number }>();
  const exportItems = await db
    .prepare(`SELECT COUNT(*) AS n FROM receipt_export_items WHERE item_type='receipt' AND item_id = ?`)
    .bind(id)
    .first<{ n: number }>();
  const exportRows = await db
    .prepare(`SELECT DISTINCT e.export_month FROM receipt_export_items i JOIN receipt_exports e ON e.id = i.export_id WHERE i.item_type='receipt' AND i.item_id = ?`)
    .bind(id)
    .all<{ export_month: string }>();
  const tripRows = await db
    .prepare(`SELECT DISTINCT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id = ?`)
    .bind(id)
    .all<{ business_trip_report_id: string }>();
  const email = await db
    .prepare(`SELECT 1 AS ok FROM email_receipt_intake WHERE promoted_receipt_id = ? LIMIT 1`)
    .bind(id)
    .first();
  const att = await db
    .prepare(`SELECT attendee_name FROM receipt_attendees WHERE receipt_id = ? ORDER BY created_at`)
    .bind(id)
    .all<{ attendee_name: string }>();
  const proof = await db
    .prepare(`SELECT 1 AS ok FROM receipt_files WHERE object_type='receipt' AND object_id=? AND role='proof_copy' LIMIT 1`)
    .bind(id)
    .first();

  const attendees = (att.results ?? []).map((a) => a.attendee_name);
  const input = buildInput(row, {
    claimedByConfirmedAmexLine: !!claim,
    businessTripLinked: (tripRows.results ?? []).length > 0,
    emailIntakePromoted: !!email,
    attendeesCount: attendees.length,
    hasProofFile: !!proof,
    // §1 correction: export-item membership is authoritative, not just status.
    // A receipt in receipt_export_items is protected even if status drifted.
    exported: row.status === "exported" || (exportItems?.n ?? 0) > 0,
  });

  return {
    input,
    row,
    attendees,
    amexClaim: claim ? { month: claim.statement_month, lineId: claim.id } : null,
    amexClaimCount: claimCount?.n ?? 0,
    exportItemsCount: exportItems?.n ?? 0,
    exportMonths: (exportRows.results ?? []).map((e) => e.export_month),
    businessTripIds: (tripRows.results ?? []).map((t) => t.business_trip_report_id),
    emailIntakePromoted: !!email,
    hasProofFile: !!proof,
  };
}

// ─── R2 inventory (spec F + correction §7) ──────────────────────────────────

export async function inventoryR2Keys(
  db: D1Database,
  receiptId: string,
): Promise<{ keys: R2KeyRef[]; originalSha256: string | null; unknownBuckets: string[]; fileRows: Array<{id: string; r2_bucket: string; r2_key: string}> }> {
  const r = await db
    .prepare(`SELECT original_r2_key, processed_r2_key, extraction_r2_key, original_sha256 FROM receipt_records WHERE id = ?`)
    .bind(receiptId)
    .first<{ original_r2_key: string | null; processed_r2_key: string | null; extraction_r2_key: string | null; original_sha256: string | null }>();

  const seen = new Set<string>();
  const keys: R2KeyRef[] = [];
  const unknownBuckets: string[] = [];
  const add = (bucket: R2BucketName, key: string | null | undefined) => {
    if (!key) return;
    const id = `${bucket}|${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    keys.push({ bucket, key });
  };

  // Column keys live in the LIVE receipts bucket.
  add("RECEIPTS_BUCKET", r?.original_r2_key);
  add("RECEIPTS_BUCKET", r?.processed_r2_key);
  add("RECEIPTS_BUCKET", r?.extraction_r2_key);

  // Manifest rows carry their own r2_bucket — map it; reject unknown. Also
  // capture the row ids so the batch can delete ONLY inventoried rows (§3 TOCTOU:
  // a new manifest row appearing after inventory must not be silently deleted).
  const fileRows: Array<{id: string; r2_bucket: string; r2_key: string}> = [];
  const files = await db
    .prepare(`SELECT id, r2_bucket, r2_key FROM receipt_files WHERE object_type='receipt' AND object_id=?`)
    .bind(receiptId)
    .all<{ id: string; r2_bucket: string; r2_key: string }>();
  for (const f of files.results ?? []) {
    const bucket = mapBucketName(f.r2_bucket);
    if (bucket === null) {
      unknownBuckets.push(`${f.r2_bucket}:${f.r2_key}`);
      continue;
    }
    fileRows.push({ id: f.id, r2_bucket: f.r2_bucket, r2_key: f.r2_key });
    add(bucket, f.r2_key);
  }

  return { keys, originalSha256: r?.original_sha256 ?? null, unknownBuckets, fileRows };
}

/** Prefix-list a bucket under `receipts/<id>/` for unmanifested derivatives. */
async function listPrefix(
  bucket: R2Bucket,
  which: R2BucketName,
  receiptId: string,
  add: (b: R2BucketName, k: string) => void,
): Promise<void> {
  const prefix = `receipts/${receiptId}/`;
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ prefix, cursor, limit: 500 });
    for (const o of listed.objects) add(which, o.key);
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
}

// ─── request validation (correction §2) ─────────────────────────────────────

function validateRequest(req: PurgeRequest): void {
  if (!req.visualConfirmed) {
    throw new PurgeEligibilityError(400, "Visual confirmation is required.");
  }
  if (!req.legalHoldExceptionAcknowledged) {
    throw new PurgeEligibilityError(
      400,
      "Acknowledge the narrow duplicate exception to receipt retention / legal hold.",
    );
  }
  if (!req.reason || !req.reason.trim()) {
    throw new PurgeEligibilityError(400, "A purge reason is required.");
  }
  if (req.targets.length === 0) {
    throw new PurgeEligibilityError(400, "At least one purge target is required.");
  }
  if (req.targets.length > PURGE_TARGET_CAP) {
    throw new PurgeEligibilityError(
      400,
      `Too many purge targets (${req.targets.length}); cap is ${PURGE_TARGET_CAP}.`,
    );
  }
  const targetIds = req.targets.map((t) => t.receiptId);
  if (new Set(targetIds).size !== targetIds.length) {
    throw new PurgeEligibilityError(400, "Duplicate target IDs are not allowed.");
  }
  if (targetIds.includes(req.retainedReceiptId)) {
    throw new PurgeEligibilityError(400, "Retained receipt id must not appear in targets.");
  }
  // Exact typed confirmation `PURGE <selected-target-count>`. A single id prefix
  // is NOT accepted as confirmation for several rows.
  const expected = `PURGE ${req.targets.length}`;
  if (req.confirmationText.trim() !== expected) {
    throw new PurgeEligibilityError(400, `Typed confirmation must be exactly "${expected}".`);
  }
}

// ─── candidate revalidation + per-target strength ───────────────────────────

/** Revalidate that `target` is still a strong/near candidate of `retained` and
 *  return the derived strength (server-authoritative, per pair). Uses the actual
 *  receipt rows (findAmexDuplicateCandidates reads deleted_at etc.). */
export function deriveCandidateStrength(
  retained: ReceiptRecord,
  target: ReceiptRecord,
): "strong" | "near" | null {
  const candidates = findAmexDuplicateCandidates(
    [target],
    [retained, target],
    new Set([retained.id]),
  );
  const list = candidates.get(target.id) ?? [];
  if (list.length === 0) return null;
  if (list.some((c) => c.strength === "strong" && c.otherReceiptId === retained.id)) {
    return "strong";
  }
  if (list.some((c) => c.otherReceiptId === retained.id)) return "near";
  return null;
}

// ─── provenance safety (correction §6) ──────────────────────────────────────

/** Parse a source_receipt_ids_json. Returns the id array, or null if malformed
 *  / non-array (caller must abort — never erase). */
export function parseSourceIds(json: string | null): string[] | null {
  if (json == null || json === "") return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const ids: string[] = [];
  for (const x of arr) {
    if (typeof x !== "string") return null;
    ids.push(x);
  }
  return ids;
}

/** Returns the rewritten json ONLY when the parsed exact id array contains
 *  target. Returns null to signal "leave byte-for-byte untouched" (LIKE false
 *  positive). Malformed json is rejected by the caller before this is used. */
export function rewriteSourceIds(
  json: string | null,
  targetId: string,
  retainedId: string,
): { rewritten: string } | null {
  const ids = parseSourceIds(json);
  if (ids === null) return null; // malformed (aborted earlier, not here)
  if (!ids.includes(targetId)) return null; // LIKE false positive → untouched
  // §5: deduplicate the COMPLETE resulting ID list preserving first-seen order,
  // remove the target, and ensure retained appears exactly once.
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (id === targetId) continue;
    if (!seen.has(id)) {
      seen.add(id);
      next.push(id);
    }
  }
  if (!seen.has(retainedId)) next.push(retainedId);
  return { rewritten: JSON.stringify(next) };
}

/** §4: Pure cluster-ID normalization (testable without Clerk/route). */
export function normalizeClusterIds(
  rawIds: string[],
): { ok: true; ids: string[] } | { ok: false; error: string; status: 400 } {
  const ids = rawIds.filter((s) => s.trim().length > 0);
  if (ids.length < 2) {
    return { ok: false, error: "Provide at least 2 ids.", status: 400 };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "Duplicate receipt IDs in cluster request.", status: 400 };
  }
  if (ids.length > PURGE_TARGET_CAP + 1) {
    return { ok: false, error: `Cluster too large (${ids.length} ids); max is ${PURGE_TARGET_CAP + 1}.`, status: 400 };
  }
  return { ok: true, ids };
}

// ─── D1 batch builder (one atomic batch for all targets) ────────────────────

interface PreflightTarget {
  input: DuplicateMemberInput;
  row: ReceiptRecord;
  strength: "strong" | "near";
  inventory: { keys: R2KeyRef[]; originalSha256: string | null; fileRows: Array<{id: string; r2_bucket: string; r2_key: string}> };
}

function buildAtomicBatch(
  db: D1Database,
  retainedId: string,
  retainedExpectedUpdatedAt: string,
  now: string,
  targets: Array<{
    pt: PreflightTarget;
    purgeJobId: string;
    pendingKeysJson: string;
    objectCount: number;
    reason: string;
    actor: string;
    legalAck: boolean;
    tripLinks: Array<{ business_trip_report_id: string }>;
    categoryRules: Array<{ id: string; source_receipt_ids_json: string | null }>;
  }>,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];

  for (const t of targets) {
    const id = t.pt.input.id;
    // §3 TOCTOU: Transfer ALL current target trip links to retained at write
    // time (not from a preflight snapshot). A new link added after preflight is
    // included. Uses a deterministic id derived from (target, trip) for uniqueness.
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO business_trip_report_receipts (id, business_trip_report_id, receipt_id, created_at)
           SELECT 'purge-' || ? || '-' || business_trip_report_id, business_trip_report_id, ?, ?
             FROM business_trip_report_receipts WHERE receipt_id = ?`,
      ).bind(id, retainedId, now, id),
    );
    stmts.push(db.prepare(`DELETE FROM business_trip_report_receipts WHERE receipt_id = ?`).bind(id));
    // Transfer email-intake promotion.
    stmts.push(
      db.prepare(`UPDATE email_receipt_intake SET promoted_receipt_id = ? WHERE promoted_receipt_id = ?`).bind(retainedId, id),
    );
    // §3 TOCTOU: Optimistic comparison on source_receipt_ids_json. If the value
    // changed concurrently, the UPDATE matches 0 rows → the rule still contains
    // the target → the trigger's residual json_each check aborts the batch.
    for (const rule of t.categoryRules) {
      const rw = rewriteSourceIds(rule.source_receipt_ids_json, id, retainedId);
      if (rw === null) continue; // LIKE false positive → untouched
      stmts.push(
        db.prepare(`UPDATE merchant_category_rules SET source_receipt_ids_json = ? WHERE id = ? AND source_receipt_ids_json = ?`)
          .bind(rw.rewritten, rule.id, rule.source_receipt_ids_json),
      );
    }
    // Reference cleanup.
    stmts.push(db.prepare(`DELETE FROM receipt_attendees WHERE receipt_id = ?`).bind(id));
    stmts.push(db.prepare(`DELETE FROM receipt_compliance_checks WHERE object_type = 'receipt' AND object_id = ?`).bind(id));
    // §3 TOCTOU + item 2: Full compare-and-delete for each manifest row. Deletes
    // only if (id, object_type, object_id, r2_bucket, r2_key) all match the
    // inventoried values. If a row's bucket/key changed after inventory, the
    // DELETE matches 0 rows → the row survives → the trigger's residual
    // receipt_files check aborts the batch. A new row appearing after inventory
    // is not inventoried → not deleted → same residual abort.
    for (const fr of t.pt.inventory.fileRows) {
      stmts.push(
        db.prepare(
          `DELETE FROM receipt_files WHERE id = ? AND object_type = 'receipt' AND object_id = ? AND r2_bucket = ? AND r2_key = ?`,
        ).bind(fr.id, id, fr.r2_bucket, fr.r2_key),
      );
    }
    stmts.push(db.prepare(`DELETE FROM receipt_audit_log WHERE object_type = 'receipt' AND object_id = ?`).bind(id));
    // Tombstone (d1_pending) — carries the optimistic guards the trigger checks.
    stmts.push(
      db.prepare(
        `INSERT INTO duplicate_purge_log
          (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength,
           purged_original_sha256, storage_object_count, pending_keys_json, status,
           expected_updated_at, retained_expected_updated_at, legal_hold_exception_acknowledged, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1_pending', ?, ?, ?, ?)`,
      ).bind(
        t.purgeJobId,
        id,
        retainedId,
        t.actor,
        t.reason,
        t.pt.strength,
        t.pt.inventory.originalSha256,
        t.objectCount,
        t.pendingKeysJson,
        t.pt.input.updated_at, // expected_updated_at (preflight)
        retainedExpectedUpdatedAt,
        t.legalAck ? 1 : 0,
        now,
      ),
    );
    // The guarded delete — the migration-0032 trigger RAISE(ROLLBACK)s the whole
    // batch if this row (or the retained row) changed since preflight.
    stmts.push(db.prepare(`DELETE FROM receipt_records WHERE id = ?`).bind(id));
  }

  // Transition every job to storage_pending AFTER all guarded deletes succeeded
  // (still inside the same atomic batch).
  for (const t of targets) {
    stmts.push(
      db.prepare(`UPDATE duplicate_purge_log SET status = 'storage_pending' WHERE id = ?`).bind(t.purgeJobId),
    );
  }

  return stmts;
}

// ─── R2 delete + verify ─────────────────────────────────────────────────────

function bucketFor(ref: R2KeyRef, receiptsBucket: R2Bucket, archiveBucket: R2Bucket): R2Bucket {
  return ref.bucket === "RECEIPTS_ARCHIVE_BUCKET" ? archiveBucket : receiptsBucket;
}

// §5 correction: attempt delete for EVERY key, then head-verify EVERY key (even
// if some deletes failed), report combined failures + actual remaining count.
// Never stop early on the first error — a later key might still be deletable.
async function deleteAndVerify(
  keys: R2KeyRef[],
  receiptsBucket: R2Bucket,
  archiveBucket: R2Bucket,
): Promise<{ ok: boolean; error: string | null; remaining: number }> {
  const errors: string[] = [];
  // Phase 1: attempt delete every key (collect errors, don't stop).
  for (const ref of keys) {
    const bkt = bucketFor(ref, receiptsBucket, archiveBucket);
    try {
      await bkt.delete(ref.key);
    } catch (err) {
      errors.push(`R2 delete failed for ${ref.bucket}:${ref.key}: ${(err as Error).message}`);
    }
  }
  // Phase 2: head-verify every key (even if some deletes failed).
  let remaining = 0;
  for (const ref of keys) {
    const bkt = bucketFor(ref, receiptsBucket, archiveBucket);
    try {
      const after = await bkt.head(ref.key);
      if (after) remaining += 1;
    } catch (err) {
      remaining += 1; // can't verify → treat as remaining
      errors.push(`R2 head-verify failed for ${ref.bucket}:${ref.key}: ${(err as Error).message}`);
    }
  }
  // §4: Final state is authoritative. If every head confirms absence, cleanup is
  // completed — delete-call errors are warnings, not failures (the object is
  // gone regardless of whether the API call threw). Only a present object or a
  // head error (can't verify) leaves storage_failed.
  if (remaining === 0) {
    return { ok: true, error: null, remaining: 0 };
  }
  return {
    ok: false,
    error: errors.join("; ") || `${remaining} key(s) still present after delete`,
    remaining,
  };
}

// ─── orchestrator ───────────────────────────────────────────────────────────

export async function purgeDuplicate(req: PurgeRequest): Promise<PurgeResult> {
  validateRequest(req);

  // ── 1. Load retained + every selected target (shared loader) ──
  const retainedRec = await fetchMemberAssessment(req.db, req.retainedReceiptId);
  if (!retainedRec) {
    throw new PurgeEligibilityError(409, "Retained receipt not found or deleted.");
  }
  if (retainedRec.row.updated_at !== req.retainedExpectedUpdatedAt) {
    throw new PurgeEligibilityError(409, "Retained receipt changed (stale) — re-open the comparison.");
  }

  const targetRecs: MemberAssessmentRecord[] = [];
  for (const t of req.targets) {
    const rec = await fetchMemberAssessment(req.db, t.receiptId);
    if (!rec) {
      throw new PurgeEligibilityError(409, `Target ${t.receiptId.slice(0, 8)} not found or deleted.`);
    }
    targetRecs.push(rec);
  }

  // ── 2. Preflight ALL targets (no mutation if any fails) ──
  const selection = assessSelection(
    [retainedRec.input, ...targetRecs.map((t) => t.input)],
    req.retainedReceiptId,
    req.targets.map((t) => t.receiptId),
  );
  if (selection.blocked) {
    throw new PurgeEligibilityError(422, `Selection blocked: ${selection.blockReasons.join(" | ")}`);
  }

  const prefetched: PreflightTarget[] = [];
  for (const [i, t] of targetRecs.entries()) {
    const expected = req.targets[i]!.expectedUpdatedAt;
    const id = t.input.id;
    if (t.row.deleted_at) {
      throw new PurgeEligibilityError(409, `Target ${id.slice(0, 8)} is deleted.`);
    }
    if (!PRE_RECON_STATUSES.includes(t.row.status)) {
      throw new PurgeEligibilityError(409, `Target ${id.slice(0, 8)} status is "${t.row.status}" — only captured/needs_review/reviewed duplicates may be purged.`);
    }
    if (t.amexClaimCount > 0) {
      throw new PurgeEligibilityError(409, `Target ${id.slice(0, 8)} is claimed by a matched/confirmed AMEX line — unlink in reconcile first.`);
    }
    if (t.exportItemsCount > 0) {
      throw new PurgeEligibilityError(409, `Target ${id.slice(0, 8)} appears in a receipt_export_items row — it has shipped and cannot be purged.`);
    }
    if (isPendingProcessing(t.row)) {
      throw new PurgeEligibilityError(409, `Target ${id.slice(0, 8)} extraction is still queued/processing — wait for terminal state.`);
    }
    if (t.row.updated_at !== expected) {
      throw new PurgeEligibilityError(409, `Target ${id.slice(0, 8)} updated_at changed (stale) — re-open and retry.`);
    }
    const strength = deriveCandidateStrength(retainedRec.row, t.row);
    if (strength === null) {
      throw new PurgeEligibilityError(409, `Target ${id.slice(0, 8)} is not a duplicate candidate of the retained receipt (revalidated server-side).`);
    }
    prefetched.push({ input: t.input, row: t.row, strength, inventory: { keys: [], originalSha256: null, fileRows: [] } });
  }

  // ── 3. Inventory R2 keys + parse provenance for EVERY target (before batch) ─
  const now = nowIso();
  const targetMeta: Array<{
    pt: PreflightTarget;
    purgeJobId: string;
    pendingKeysJson: string;
    objectCount: number;
    reason: string;
    actor: string;
    legalAck: boolean;
    tripLinks: Array<{ business_trip_report_id: string }>;
    categoryRules: Array<{ id: string; source_receipt_ids_json: string | null }>;
  }> = [];

  for (const pt of prefetched) {
    const inv = await inventoryR2Keys(req.db, pt.input.id);
    if (inv.unknownBuckets.length > 0) {
      throw new PurgeEligibilityError(
        409,
        `Target ${pt.input.id.slice(0, 8)} has unknown manifest bucket value(s): ${inv.unknownBuckets.join(", ")} — refusing to purge.`,
      );
    }
    pt.inventory = { keys: inv.keys, originalSha256: inv.originalSha256, fileRows: inv.fileRows };

    // Full R2 inventory incl. prefix-listed derivatives across both buckets.
    const seen = new Set<string>();
    const allKeys: R2KeyRef[] = [];
    const add = (b: R2BucketName, k: string) => {
      const idk = `${b}|${k}`;
      if (seen.has(idk)) return;
      seen.add(idk);
      allKeys.push({ bucket: b, key: k });
    };
    for (const k of pt.inventory.keys) add(k.bucket, k.key);
    await listPrefix(req.receiptsBucket, "RECEIPTS_BUCKET", pt.input.id, add);
    await listPrefix(req.archiveBucket, "RECEIPTS_ARCHIVE_BUCKET", pt.input.id, add);

    // Parse/validate provenance (category rules) before any mutation.
    const likeRows = await req.db
      .prepare(`SELECT id, source_receipt_ids_json FROM merchant_category_rules WHERE source_receipt_ids_json LIKE ?`)
      .bind(`%${pt.input.id}%`)
      .all<{ id: string; source_receipt_ids_json: string | null }>();
    const categoryRules: Array<{ id: string; source_receipt_ids_json: string | null }> = [];
    for (const rule of likeRows.results ?? []) {
      if (parseSourceIds(rule.source_receipt_ids_json) === null) {
        throw new PurgeEligibilityError(
          409,
          `merchant_category_rules ${rule.id.slice(0, 8)} has malformed source_receipt_ids_json — aborting purge (would risk erasing provenance).`,
        );
      }
      categoryRules.push(rule);
    }

    targetMeta.push({
      pt,
      purgeJobId: newUuid(),
      pendingKeysJson: JSON.stringify(allKeys),
      objectCount: allKeys.length, // §5: final deduplicated count incl. derivatives
      reason: req.reason,
      actor: req.actor,
      legalAck: req.legalHoldExceptionAcknowledged,
      tripLinks: (targetRecs.find((r) => r.input.id === pt.input.id)?.businessTripIds ?? []).map(
        (bid) => ({ business_trip_report_id: bid }),
      ),
      categoryRules,
    });
  }

  // ── 4. One atomic D1 batch for ALL targets (trigger-guarded) ──
  const batch = buildAtomicBatch(req.db, req.retainedReceiptId, req.retainedExpectedUpdatedAt, now, targetMeta);
  await req.db.batch(batch); // RAISE(ROLLBACK) on any write-time guard → whole batch undone

  // ── 5. R2 cleanup — only after the D1 batch committed; retryable ──
  const results: PurgedTargetResult[] = [];
  let allCompleted = true;
  for (const tm of targetMeta) {
    const keys = JSON.parse(tm.pendingKeysJson) as R2KeyRef[];
    const del = await deleteAndVerify(keys, req.receiptsBucket, req.archiveBucket);
    const ts = nowIso();
    if (del.ok) {
      await req.db
        .prepare(`UPDATE duplicate_purge_log SET status='completed', completed_at=?, pending_keys_json=NULL, error_text=NULL WHERE id=?`)
        .bind(ts, tm.purgeJobId)
        .run();
      results.push({
        receiptId: tm.pt.input.id,
        purgeJobId: tm.purgeJobId,
        status: "completed",
        strength: tm.pt.strength,
        objectCount: keys.length,
        remainingKeys: 0,
        originalSha256: tm.pt.inventory.originalSha256,
        errorText: null,
      });
    } else {
      await req.db
        .prepare(`UPDATE duplicate_purge_log SET status='storage_failed', error_text=? WHERE id=?`)
        .bind(del.error, tm.purgeJobId)
        .run();
      results.push({
        receiptId: tm.pt.input.id,
        purgeJobId: tm.purgeJobId,
        status: "storage_failed",
        strength: tm.pt.strength,
        objectCount: keys.length,
        remainingKeys: del.remaining,
        originalSha256: tm.pt.inventory.originalSha256,
        errorText: del.error,
      });
      allCompleted = false;
    }
  }

  return { completed: allCompleted, targets: results };
}

// ─── idempotent retry (correction §7) ───────────────────────────────────────

export interface RetryResult {
  purgeJobId: string;
  status: "completed" | "storage_failed";
  remainingKeys: number;
  error: string | null;
}

export async function retryR2Cleanup(args: {
  db: D1Database;
  receiptsBucket: R2Bucket;
  archiveBucket: R2Bucket;
  purgeJobId: string;
}): Promise<RetryResult> {
  const job = await args.db
    .prepare(`SELECT pending_keys_json, status FROM duplicate_purge_log WHERE id = ?`)
    .bind(args.purgeJobId)
    .first<{ pending_keys_json: string | null; status: string }>();
  if (!job) {
    throw new PurgeEligibilityError(404, `Purge job ${args.purgeJobId} not found.`);
  }
  if (job.status === "completed") {
    return { purgeJobId: args.purgeJobId, status: "completed", remainingKeys: 0, error: null };
  }
  if (job.status === "d1_pending") {
    throw new PurgeEligibilityError(409, `Job ${args.purgeJobId} is still d1_pending — not retryable yet.`);
  }
  // Malformed/missing inventory is NEVER interpreted as [] (which would falsely
  // mark the job completed). It stays storage_failed.
  const keys = parsePendingKeys(job.pending_keys_json);
  if (keys === null) {
    const ts = nowIso();
    await args.db
      .prepare(`UPDATE duplicate_purge_log SET status='storage_failed', error_text=? WHERE id=?`)
      .bind(`Malformed or missing pending key inventory for ${args.purgeJobId}`, args.purgeJobId)
      .run();
    return {
      purgeJobId: args.purgeJobId,
      status: "storage_failed",
      remainingKeys: 0,
      error: "Malformed or missing pending key inventory",
    };
  }
  const del = await deleteAndVerify(keys, args.receiptsBucket, args.archiveBucket);
  const ts = nowIso();
  if (del.ok) {
    await args.db
      .prepare(`UPDATE duplicate_purge_log SET status='completed', completed_at=?, pending_keys_json=NULL, error_text=NULL WHERE id=?`)
      .bind(ts, args.purgeJobId)
      .run();
    return { purgeJobId: args.purgeJobId, status: "completed", remainingKeys: 0, error: null };
  }
  await args.db
    .prepare(`UPDATE duplicate_purge_log SET status='storage_failed', error_text=? WHERE id=?`)
    .bind(del.error, args.purgeJobId)
    .run();
  return { purgeJobId: args.purgeJobId, status: "storage_failed", remainingKeys: del.remaining, error: del.error };
}

/** List purge jobs still needing operator attention (storage_failed/pending). */
export async function listIncompletePurgeJobs(db: D1Database): Promise<
  Array<{
    id: string;
    purged_receipt_id: string;
    retained_receipt_id: string;
    status: string;
    error_text: string | null;
    storage_object_count: number;
    created_at: string;
  }>
> {
  const res = await db
    .prepare(
      `SELECT id, purged_receipt_id, retained_receipt_id, status, error_text, storage_object_count, created_at
       FROM duplicate_purge_log WHERE status IN ('storage_failed','storage_pending')
       ORDER BY created_at DESC`,
    )
    .all();
  return (res.results ?? []) as Array<{
    id: string;
    purged_receipt_id: string;
    retained_receipt_id: string;
    status: string;
    error_text: string | null;
    storage_object_count: number;
    created_at: string;
  }>;
}
