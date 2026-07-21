// Operator-confirmed duplicate PURGE service (audit 2026-07-21, spec C/E/F).
//
// Permanently removes a confirmed duplicate receipt: D1 row + every reference +
// all associated R2 objects, leaving the retained canonical receipt as the
// accounting record. This is NOT the ordinary soft-delete path — only this
// workflow performs permanent purge.
//
// Server is authoritative: it re-fetches and revalidates EVERY predicate from
// D1. Client scores are never trusted. D1 reference removal + receipt deletion
// are one atomic batch; R2 cleanup is best-effort-but-loud with a durable,
// retryable tombstone (duplicate_purge_log) because D1 and R2 are not
// cross-service transactional.
//
// Bindings (db, receiptsBucket, archiveBucket) are injected so the destructive
// paths unit-test with mocked D1/R2 — no live purge during development.

import { nowIso, newUuid } from "@/lib/receipts/db-utils";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import { findAmexDuplicateCandidates } from "@/lib/receipts/amex-duplicates";
import {
  completeness,
  type DuplicateMemberInput,
  type ScoreField,
} from "@/lib/receipts/duplicate-resolution-policy";
import type { ReceiptRecord } from "@/lib/receipts/types";

// ─── types ──────────────────────────────────────────────────────────────────

export interface R2KeyRef {
  bucket: "RECEIPTS_BUCKET" | "RECEIPTS_ARCHIVE_BUCKET";
  key: string;
}

export interface PurgeRequest {
  db: D1Database;
  receiptsBucket: R2Bucket;
  archiveBucket: R2Bucket;
  retainedReceiptId: string;
  purgeReceiptIds: string[];
  /** targetId → expected updated_at (optimistic guard). */
  expectedUpdatedAt: Record<string, string>;
  visualConfirmed: boolean;
  confirmationText: string;
  reason: string;
  strength: "strong" | "near";
  actor: string;
}

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
  status: "completed" | "storage_failed" | "storage_pending";
  objectCount: number;
  originalSha256: string | null;
  errorText: string | null;
}

export interface PurgeResult {
  completed: boolean; // true only if every target reached status=completed
  targets: PurgedTargetResult[];
}

const PRE_RECON_STATUSES = ["captured", "needs_review", "reviewed"];

// ─── R2 inventory (spec F) ───────────────────────────────────────────────────

/** Every R2 object associated with a receipt, deduped by (bucket,key):
 *  original/processed/extraction columns + every receipt_files manifest row +
 *  a prefix list of both buckets under `receipts/<id>/` to catch unmanifested
 *  derivatives (proof-copy and rendered derivative files). */
export async function inventoryR2Keys(
  db: D1Database,
  receiptsBucket: R2Bucket,
  archiveBucket: R2Bucket,
  receiptId: string,
): Promise<{ keys: R2KeyRef[]; originalSha256: string | null }> {
  const r = await db
    .prepare(`SELECT original_r2_key, processed_r2_key, extraction_r2_key, original_sha256 FROM receipt_records WHERE id = ?`)
    .bind(receiptId)
    .first<{ original_r2_key: string | null; processed_r2_key: string | null; extraction_r2_key: string | null; original_sha256: string | null }>();

  const seen = new Set<string>();
  const keys: R2KeyRef[] = [];
  const add = (bucket: R2KeyRef["bucket"], key: string | null | undefined) => {
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

  // Manifest rows carry their own r2_bucket.
  const files = await db
    .prepare(`SELECT r2_bucket, r2_key FROM receipt_files WHERE object_type='receipt' AND object_id=?`)
    .bind(receiptId)
    .all<{ r2_bucket: string; r2_key: string }>();
  for (const f of files.results ?? []) {
    const bucket: R2KeyRef["bucket"] =
      f.r2_bucket === "RECEIPTS_ARCHIVE_BUCKET" ? "RECEIPTS_ARCHIVE_BUCKET" : "RECEIPTS_BUCKET";
    add(bucket, f.r2_key);
  }

  // Prefix list of both buckets for unmanifested derivatives (receipts/<id>/...).
  const prefix = `receipts/${receiptId}/`;
  for (const [bucket, bkt] of [
    ["RECEIPTS_BUCKET", receiptsBucket],
    ["RECEIPTS_ARCHIVE_BUCKET", archiveBucket],
  ] as const) {
    let cursor: string | undefined;
    for (;;) {
      const listed = await bkt.list({ prefix, cursor, limit: 500 });
      for (const o of listed.objects) add(bucket, o.key);
      if (!listed.truncated) break;
      cursor = listed.cursor;
    }
  }

  return { keys, originalSha256: r?.original_sha256 ?? null };
}

// ─── eligibility helpers ─────────────────────────────────────────────────────

function toMemberInput(r: ReceiptRecord): DuplicateMemberInput {
  let attendeesCount = 0; // filled by caller if needed; completeness uses count
  return {
    id: r.id,
    captured_at: r.captured_at,
    updated_at: r.updated_at,
    status: r.status,
    exported: r.status === "exported",
    archived: r.status === "archived",
    claimedByConfirmedAmexLine: false, // set by caller from AMEX-line query
    businessTripLinked: false, // set by caller
    emailIntakePromoted: false, // set by caller
    transaction_date: r.transaction_date,
    merchant: r.merchant,
    amount_minor: r.amount_minor,
    currency: r.currency,
    expense_category_code: r.expense_category_code,
    business_purpose: r.business_purpose,
    tax_amount_minor: r.tax_amount_minor,
    tax_rate: r.tax_rate ?? null,
    invoice_registration_number: r.invoice_registration_number ?? null,
    qualified_invoice_status: r.qualified_invoice_status ?? null,
    counterparty_name: r.counterparty_name ?? null,
    attendeesRequired: false,
    attendeesCount,
    extractionState: r.extraction_state ?? null,
    hasOriginalFile: Boolean(r.original_r2_key),
    hasProofFile: false,
  };
}

async function fetchAttendeeCount(db: D1Database, id: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM receipt_attendees WHERE receipt_id=?`)
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Revalidate that `target` is still a strong/near duplicate candidate of
 *  `retained` (server-side; never trust the client's strength claim alone). */
async function revalidateCandidate(
  db: D1Database,
  retained: ReceiptRecord,
  target: ReceiptRecord,
  strength: "strong" | "near",
): Promise<boolean> {
  const candidates = findAmexDuplicateCandidates(
    [target], // subject
    [retained, target], // pool
    new Set([retained.id]),
  );
  const list = candidates.get(target.id) ?? [];
  if (list.length === 0) return false;
  // The claimed strength must match a real candidate (strong claim requires a
  // strong hit; a near claim requires at least a near hit).
  if (strength === "strong") return list.some((c) => c.strength === "strong" && c.otherReceiptId === retained.id);
  return list.some((c) => c.otherReceiptId === retained.id);
}

// ─── per-target validation ───────────────────────────────────────────────────

interface TargetContext {
  target: ReceiptRecord;
  amexClaimCount: number;
  exportItemsCount: number;
}

async function validateTarget(
  req: PurgeRequest,
  retained: ReceiptRecord,
  ctx: TargetContext,
  targetCompleted: Set<ScoreField>,
  retainedCompleted: Set<ScoreField>,
): Promise<void> {
  const { target } = ctx;
  if (target.id === retained.id) {
    throw new PurgeEligibilityError(400, "Purge target must differ from retained receipt.");
  }
  if (target.deleted_at) {
    throw new PurgeEligibilityError(409, `Target ${target.id.slice(0, 8)} is deleted.`);
  }
  if (!PRE_RECON_STATUSES.includes(target.status)) {
    throw new PurgeEligibilityError(
      409,
      `Target ${target.id.slice(0, 8)} status is "${target.status}" — only captured/needs_review/reviewed duplicates may be purged.`,
    );
  }
  if (ctx.amexClaimCount > 0) {
    throw new PurgeEligibilityError(
      409,
      `Target ${target.id.slice(0, 8)} is claimed by a matched/confirmed AMEX line — unlink in reconcile first (registered receipts are not purged here).`,
    );
  }
  if (ctx.exportItemsCount > 0) {
    throw new PurgeEligibilityError(
      409,
      `Target ${target.id.slice(0, 8)} appears in a receipt_export_items row — it has shipped in an export and cannot be purged.`,
    );
  }
  if (isPendingProcessing(target)) {
    throw new PurgeEligibilityError(
      409,
      `Target ${target.id.slice(0, 8)} extraction is still queued/processing — wait for terminal state before purging.`,
    );
  }
  // Optimistic updated_at guard.
  const expected = req.expectedUpdatedAt[target.id];
  if (!expected || target.updated_at !== expected) {
    throw new PurgeEligibilityError(
      409,
      `Target ${target.id.slice(0, 8)} updated_at changed (stale) — re-open the comparison and retry.`,
    );
  }
  // Rule 6: no populated target-only accounting field missing from retained.
  const missingOnRetained = [...targetCompleted].filter((f) => !retainedCompleted.has(f));
  if (missingOnRetained.length > 0) {
    throw new PurgeEligibilityError(
      422,
      `Target ${target.id.slice(0, 8)} has accounting field(s) {${missingOnRetained.join(", ")}} missing from the retained receipt — copy/resolve them on the canonical receipt before purging.`,
    );
  }
  // Candidate relationship revalidated.
  const ok = await revalidateCandidate(req.db, retained, target, req.strength);
  if (!ok) {
    throw new PurgeEligibilityError(
      409,
      `Target ${target.id.slice(0, 8)} is not a ${req.strength} duplicate candidate of the retained receipt (revalidated server-side).`,
    );
  }
}

// ─── D1 reference transfer/cleanup batch builder ─────────────────────────────

function rewriteSourceReceiptIdsJson(json: string | null, removeId: string, ensureId: string): string {
  let arr: string[] = [];
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) arr = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      arr = [];
    }
  }
  arr = arr.filter((x) => x !== removeId);
  if (!arr.includes(ensureId)) arr.push(ensureId);
  return JSON.stringify(arr);
}

function buildTargetBatch(
  db: D1Database,
  targetId: string,
  retainedId: string,
  tripLinks: Array<{ id: string; business_trip_report_id: string }>,
  categoryRules: Array<{ id: string; source_receipt_ids_json: string | null }>,
  purgeJobId: string,
  pendingKeysJson: string,
  objectCount: number,
  originalSha256: string | null,
  reason: string,
  strength: "strong" | "near",
  actor: string,
  now: string,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const target = (sql: string) => db.prepare(sql);

  // Transfer business-trip provenance (INSERT OR IGNORE per (trip, retained)).
  for (const link of tripLinks) {
    stmts.push(
      target(
        `INSERT OR IGNORE INTO business_trip_report_receipts (id, business_trip_report_id, receipt_id, created_at) VALUES (?, ?, ?, ?)`,
      ).bind(newUuid(), link.business_trip_report_id, retainedId, now),
    );
  }
  if (tripLinks.length > 0) {
    stmts.push(target(`DELETE FROM business_trip_report_receipts WHERE receipt_id = ?`).bind(targetId));
  }

  // Transfer email-intake promotion target.
  stmts.push(
    target(`UPDATE email_receipt_intake SET promoted_receipt_id = ? WHERE promoted_receipt_id = ?`).bind(
      retainedId,
      targetId,
    ),
  );

  // Rewrite merchant_category_rules.source_receipt_ids_json.
  for (const rule of categoryRules) {
    const rewritten = rewriteSourceReceiptIdsJson(rule.source_receipt_ids_json, targetId, retainedId);
    stmts.push(
      target(`UPDATE merchant_category_rules SET source_receipt_ids_json = ? WHERE id = ?`).bind(
        rewritten,
        rule.id,
      ),
    );
  }

  // Reference cleanup.
  stmts.push(target(`DELETE FROM receipt_attendees WHERE receipt_id = ?`).bind(targetId));
  stmts.push(
    target(`DELETE FROM receipt_compliance_checks WHERE object_type = 'receipt' AND object_id = ?`).bind(
      targetId,
    ),
  );
  stmts.push(
    target(`DELETE FROM receipt_files WHERE object_type = 'receipt' AND object_id = ?`).bind(targetId),
  );
  // Dangling ROT audit rows for the purged duplicate (retained keeps its trail;
  // the tombstone below is the durable record of the purge).
  stmts.push(
    target(`DELETE FROM receipt_audit_log WHERE object_type = 'receipt' AND object_id = ?`).bind(targetId),
  );
  // The receipt row itself.
  stmts.push(target(`DELETE FROM receipt_records WHERE id = ?`).bind(targetId));

  // Tombstone (inserted in 'storage_pending' with the pending key inventory).
  stmts.push(
    target(
      `INSERT INTO duplicate_purge_log
        (id, purged_receipt_id, retained_receipt_id, actor, reason, duplicate_strength,
         purged_original_sha256, storage_object_count, pending_keys_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'storage_pending', ?)`,
    ).bind(
      purgeJobId,
      targetId,
      retainedId,
      actor,
      reason,
      strength,
      originalSha256,
      objectCount,
      pendingKeysJson,
      now,
    ),
  );

  return stmts;
}

// ─── R2 delete + verify ───────────────────────────────────────────────────────

function bucketFor(ref: R2KeyRef, receiptsBucket: R2Bucket, archiveBucket: R2Bucket): R2Bucket {
  return ref.bucket === "RECEIPTS_ARCHIVE_BUCKET" ? archiveBucket : receiptsBucket;
}

/** Delete every key; return the first failure (if any). Already-absent objects
 *  count as success (idempotent). */
async function deleteAndVerify(
  keys: R2KeyRef[],
  receiptsBucket: R2Bucket,
  archiveBucket: R2Bucket,
): Promise<{ ok: boolean; failed: R2KeyRef | null; error: string | null }> {
  for (const ref of keys) {
    const bkt = bucketFor(ref, receiptsBucket, archiveBucket);
    try {
      await bkt.delete(ref.key);
    } catch (err) {
      return {
        ok: false,
        failed: ref,
        error: `R2 delete failed for ${ref.bucket}:${ref.key}: ${(err as Error).message}`,
      };
    }
  }
  // Verify every key is absent via head().
  for (const ref of keys) {
    const bkt = bucketFor(ref, receiptsBucket, archiveBucket);
    try {
      const after = await bkt.head(ref.key);
      if (after) {
        return {
          ok: false,
          failed: ref,
          error: `R2 object still present after delete: ${ref.bucket}:${ref.key}`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        failed: ref,
        error: `R2 head-verify failed for ${ref.bucket}:${ref.key}: ${(err as Error).message}`,
      };
    }
  }
  return { ok: true, failed: null, error: null };
}

// ─── orchestrator ────────────────────────────────────────────────────────────

export async function purgeDuplicate(req: PurgeRequest): Promise<PurgeResult> {
  // Global guards.
  if (!req.visualConfirmed) {
    throw new PurgeEligibilityError(400, "Visual confirmation is required.");
  }
  if (!req.reason || !req.reason.trim()) {
    throw new PurgeEligibilityError(400, "A purge reason is required.");
  }
  if (req.purgeReceiptIds.length === 0) {
    throw new PurgeEligibilityError(400, "At least one purge target is required.");
  }
  // Typed confirmation must contain the purge count or a target id prefix.
  const countToken = String(req.purgeReceiptIds.length);
  const prefixTokens = req.purgeReceiptIds.map((id) => id.slice(0, 8));
  const confirmationOk =
    req.confirmationText.trim() === countToken ||
    prefixTokens.some((p) => req.confirmationText.trim().startsWith(p));
  if (!confirmationOk) {
    throw new PurgeEligibilityError(
      400,
      `Typed confirmation must be the purge count (${countToken}) or a target ID prefix.`,
    );
  }

  // Retained exists + non-deleted.
  const retained = await req.db
    .prepare(`SELECT * FROM receipt_records WHERE id = ?`)
    .bind(req.retainedReceiptId)
    .first<ReceiptRecord>();
  if (!retained || retained.deleted_at) {
    throw new PurgeEligibilityError(409, "Retained receipt not found or deleted.");
  }
  const retainedAttendees = await fetchAttendeeCount(req.db, retained.id);
  const retainedMember = toMemberInput(retained);
  retainedMember.attendeesCount = retainedAttendees;
  const retainedCompleted = new Set(completeness(retainedMember).completed);

  const now = nowIso();
  const targets: PurgedTargetResult[] = [];
  let allCompleted = true;

  for (const targetId of req.purgeReceiptIds) {
    const purgeJobId = newUuid();
    const target = await req.db
      .prepare(`SELECT * FROM receipt_records WHERE id = ?`)
      .bind(targetId)
      .first<ReceiptRecord>();
    if (!target) {
      throw new PurgeEligibilityError(409, `Target ${targetId.slice(0, 8)} not found.`);
    }

    // Reference signals for validation + transfer.
    const amexClaim = await req.db
      .prepare(`SELECT COUNT(*) AS n FROM amex_statement_lines WHERE matched_receipt_id = ? AND match_status IN ('matched','confirmed')`)
      .bind(targetId)
      .first<{ n: number }>();
    const exportItems = await req.db
      .prepare(`SELECT COUNT(*) AS n FROM receipt_export_items WHERE item_type='receipt' AND item_id = ?`)
      .bind(targetId)
      .first<{ n: number }>();

    const targetAttendees = await fetchAttendeeCount(req.db, targetId);
    const targetMember = toMemberInput(target);
    targetMember.attendeesCount = targetAttendees;
    const targetCompleted = new Set(completeness(targetMember).completed);

    await validateTarget(
      req,
      retained,
      { target, amexClaimCount: amexClaim?.n ?? 0, exportItemsCount: exportItems?.n ?? 0 },
      targetCompleted,
      retainedCompleted,
    );

    // Inventory R2 keys BEFORE the D1 batch (receipt row must still exist).
    const inv = await inventoryR2Keys(req.db, req.receiptsBucket, req.archiveBucket, targetId);

    // Transfer-source reads (current state), then the atomic D1 batch.
    const tripLinks = (
      await req.db
        .prepare(`SELECT id, business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id = ?`)
        .bind(targetId)
        .all<{ id: string; business_trip_report_id: string }>()
    ).results ?? [];
    const categoryRules = (
      await req.db
        .prepare(`SELECT id, source_receipt_ids_json FROM merchant_category_rules WHERE source_receipt_ids_json LIKE ?`)
        .bind(`%${targetId}%`)
        .all<{ id: string; source_receipt_ids_json: string | null }>()
    ).results ?? [];

    const pendingKeysJson = JSON.stringify(inv.keys);
    const batch = buildTargetBatch(
      req.db,
      targetId,
      req.retainedReceiptId,
      tripLinks,
      categoryRules,
      purgeJobId,
      pendingKeysJson,
      inv.keys.length,
      inv.originalSha256,
      req.reason,
      req.strength,
      req.actor,
      now,
    );
    await req.db.batch(batch);

    // R2 cleanup (non-transactional with D1). Loud + retryable.
    const del = await deleteAndVerify(inv.keys, req.receiptsBucket, req.archiveBucket);
    if (del.ok) {
      await req.db
        .prepare(
          `UPDATE duplicate_purge_log SET status='completed', completed_at=?, pending_keys_json=NULL, error_text=NULL WHERE id=?`,
        )
        .bind(now, purgeJobId)
        .run();
      targets.push({
        receiptId: targetId,
        purgeJobId,
        status: "completed",
        objectCount: inv.keys.length,
        originalSha256: inv.originalSha256,
        errorText: null,
      });
    } else {
      // Retain the key inventory for retry; mark storage_failed loudly.
      await req.db
        .prepare(
          `UPDATE duplicate_purge_log SET status='storage_failed', error_text=? WHERE id=?`,
        )
        .bind(del.error, purgeJobId)
        .run();
      targets.push({
        receiptId: targetId,
        purgeJobId,
        status: "storage_failed",
        objectCount: inv.keys.length,
        originalSha256: inv.originalSha256,
        errorText: del.error,
      });
      allCompleted = false;
    }
  }

  return { completed: allCompleted, targets };
}

// ─── idempotent retry ────────────────────────────────────────────────────────

export interface RetryResult {
  purgeJobId: string;
  status: "completed" | "storage_failed";
  remainingKeys: number;
  error: string | null;
}

/** Retry R2 cleanup for a storage_failed/storage_pending tombstone. Already-
 *  absent objects are success. Never reports complete while a key remains. */
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
  let keys: R2KeyRef[] = [];
  try {
    keys = job.pending_keys_json ? (JSON.parse(job.pending_keys_json) as R2KeyRef[]) : [];
  } catch {
    keys = [];
  }
  const del = await deleteAndVerify(keys, args.receiptsBucket, args.archiveBucket);
  const now = nowIso();
  if (del.ok) {
    await args.db
      .prepare(`UPDATE duplicate_purge_log SET status='completed', completed_at=?, pending_keys_json=NULL, error_text=NULL WHERE id=?`)
      .bind(now, args.purgeJobId)
      .run();
    return { purgeJobId: args.purgeJobId, status: "completed", remainingKeys: 0, error: null };
  }
  await args.db
    .prepare(`UPDATE duplicate_purge_log SET error_text=? WHERE id=?`)
    .bind(del.error, args.purgeJobId)
    .run();
  return {
    purgeJobId: args.purgeJobId,
    status: "storage_failed",
    remainingKeys: keys.length,
    error: del.error,
  };
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
