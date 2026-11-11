// Render-leg failure admission, terminal persistence, and deliberate
// recovery (backlog #22; round-2 review B1–B4).
//
// A needs_render=1 receipt whose email body failed to render permanently is
// marked extraction_state='failed' with stage:'render' in extraction_json
// (the architect-preferred failure surface — no migration; the queue pill,
// review attention codes and pipeline health all read it). needs_render
// stays 1, so the row itself remains the discriminator between a terminal
// RENDER failure and a terminal EXTRACTION failure.
//
// Persistence rules (review B1/B2):
//   - The terminal state AND its diagnostic commit in ONE conditional UPDATE
//     whose WHERE repeats the full admission (deleted/render/status/pending
//     state) — no read-then-act window, no state-without-reason commit.
//   - Non-failure extraction data already in extraction_json is PRESERVED
//     (merged under the failure keys); the FIRST committed terminal reason
//     and timestamp are immutable — an already-terminal report is a
//     read-only idempotent success (no write, no audit).
//
// Recovery rules (review B3): retry admits only the terminal render-failure
// state, re-checks admission INSIDE the atomic write (deleted_at, status,
// state, and the canonical month/seal guards from month-lock.ts), inspects
// affected rows, and reports an honest conflict when admission was lost —
// never a false success audit.

import {
  monthLockedForEditsSql,
  receiptInFinalizedReconciliationSql,
} from "@/lib/receipts/month-lock";
import { createAuditEntry } from "@/lib/receipts/audit";
import { nowIso, stringifyJson } from "@/lib/receipts/db-utils";
import type { ReceiptRecord } from "@/lib/receipts/types";

const PENDING_STATES = ["captured", "queued", "processing"] as const;
const RENDER_PENDING_STATUSES = ["captured", "needs_review"] as const;

// ─── Request-body boundary (review B4) ───────────────────────────────────────

export type ParsedRenderFailedBody =
  | { ok: true; reason: string }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Validate the render-failed POST body BEFORE any trim/length logic:
 * the payload must be a JSON object with a string `reason`. Malformed types
 * (numbers, arrays, booleans, non-object JSON) are client errors, never 500s.
 * Pure — the route and the boundary matrix test share it.
 */
export function parseRenderFailedBody(raw: unknown): ParsedRenderFailedBody {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "Body must be a JSON object with a `reason` string." };
  }
  const reason = (raw as { reason?: unknown }).reason;
  if (typeof reason !== "string") {
    return { ok: false, status: 400, error: "`reason` must be a string." };
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: "Body must include a non-empty `reason`." };
  }
  if (trimmed.length > 1000) {
    return { ok: false, status: 413, error: "`reason` must be 1000 characters or fewer." };
  }
  return { ok: true, reason: trimmed };
}

// ─── Admission pre-checks (message builders; the atomic writes re-check) ─────

export type RenderAdmission =
  | { ok: true }
  | { ok: false; status: 409; error: string };

function lockedAdmission(receipt: ReceiptRecord): RenderAdmission {
  return {
    ok: false,
    status: 409,
    error:
      `Receipt is ${receipt.status} and cannot be acted on by the render ` +
      "pipeline — a human has already advanced it.",
  };
}

/**
 * Pre-check for POST /api/receipts/[id]/render-failed. NOT the authority:
 * recordRenderFailure repeats every condition inside its atomic UPDATE, so a
 * race that advances/deletes the receipt between read and write cannot
 * produce a partial or false-terminal commit.
 */
export function admitRenderFailure(receipt: ReceiptRecord): RenderAdmission {
  if (receipt.needs_render !== 1) {
    return {
      ok: false,
      status: 409,
      error:
        "Receipt is not awaiting a render (requires needs_render=1). " +
        `Actual: needs_render=${receipt.needs_render ?? 0}, ` +
        `extraction_state='${receipt.extraction_state ?? "captured"}'.`,
    };
  }
  if (!RENDER_PENDING_STATUSES.includes(receipt.status as never)) {
    return lockedAdmission(receipt);
  }
  return { ok: true };
}

/**
 * Pre-check for POST /api/receipts/[id]/render-retry. NOT the authority:
 * retryRender repeats every condition (plus the seal guards and deleted_at)
 * inside its atomic UPDATE and inspects affected rows. Legacy stalled rows
 * (needs_render=1, extraction_state='captured', no marker) are NOT
 * admissible — they already retry every cycle.
 */
export function admitRenderRetry(receipt: ReceiptRecord): RenderAdmission {
  if (receipt.needs_render !== 1) {
    return {
      ok: false,
      status: 409,
      error:
        "Receipt is not in the render-retry recoverable state " +
        "(requires needs_render=1 AND extraction_state='failed'). " +
        `Actual: needs_render=${receipt.needs_render ?? 0}, ` +
        `extraction_state='${receipt.extraction_state ?? "captured"}'.`,
    };
  }
  if ((receipt.extraction_state ?? "captured") !== "failed") {
    return {
      ok: false,
      status: 409,
      error:
        "Receipt is not in the render-retry recoverable state " +
        "(requires needs_render=1 AND extraction_state='failed'). " +
        `Actual: needs_render=${receipt.needs_render ?? 0}, ` +
        `extraction_state='${receipt.extraction_state ?? "captured"}' ` +
        "(legacy stalled render rows retry automatically and need no retry).",
    };
  }
  if (!RENDER_PENDING_STATUSES.includes(receipt.status as never)) {
    return lockedAdmission(receipt);
  }
  return { ok: true };
}

// ─── Terminal persistence (recordRenderFailure) ──────────────────────────────

export type RecordRenderFailureResult =
  | { kind: "recorded"; failedAt: string }
  | {
      kind: "already_terminal";
      /** The FIRST committed terminal reason (immutable on re-reports). */
      reason: string | null;
      failedAt: string | null;
    }
  | { kind: "conflict"; error: string }
  | { kind: "not_found" };

/** Minimal row shape recordRenderFailure reads. */
interface FailureRow {
  id: string;
  deleted_at: string | null;
  needs_render: number | null;
  extraction_state: string | null;
  status: string;
  extraction_json: string | null;
}

/**
 * Merge the terminal render-failure marker into an existing extraction_json
 * payload WITHOUT discarding non-failure data (review B1). Pure.
 *  - existing parseable object → its keys survive; failure keys win.
 *  - anything else (null, malformed, non-object) → fresh payload only —
 *    there is no structured data to preserve (extraction-failed precedent).
 */
export function mergeTerminalRenderPayload(
  existingJson: string | null,
  reason: string,
  failedAt: string,
): string {
  let base: Record<string, unknown> = {};
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      /* malformed — nothing preservable */
    }
  }
  return stringifyJson({
    ...base,
    failed: true as const,
    stage: "render" as const,
    reason,
    failedAt,
  });
}

/**
 * Record a terminal render failure ATOMICICALLY (review B1/B2).
 *
 * One conditional UPDATE commits state + diagnostic together, gated on the
 * full admitted state (deleted_at IS NULL, needs_render=1, pending
 * extraction_state, pre-review status). Idempotence: when the row is
 * already terminally failed (or a concurrent report won the race), the
 * FIRST committed marker is returned untouched — no second write, no second
 * audit. A thrown error anywhere before/during the UPDATE leaves the row
 * exactly as it was (single statement ⇒ no partial commit), so the render
 * leg re-attempts next cycle — the row can never be excluded from polling
 * without its reason (B2).
 */
export async function recordRenderFailure(input: {
  db: D1Database;
  receiptId: string;
  reason: string;
  actor: string;
  now?: string;
}): Promise<RecordRenderFailureResult> {
  const { db, receiptId, reason, actor } = input;
  const now = input.now ?? nowIso();

  const row = await db
    .prepare(
      `SELECT id, deleted_at, needs_render, extraction_state, status, extraction_json
       FROM receipt_records WHERE id = ?`,
    )
    .bind(receiptId)
    .first<FailureRow>();
  if (!row || row.deleted_at) return { kind: "not_found" };

  // Read-only idempotence: already terminal → return the first marker.
  // (Concurrent duplicate reports converge here after the UPDATE race below.)
  if (row.extraction_state === "failed" && row.needs_render === 1) {
    return firstTerminalMarker(row.extraction_json);
  }

  const asRecord = {
    ...row,
    captured_at: null,
  } as unknown as ReceiptRecord;
  const admission = admitRenderFailure(asRecord);
  if (!admission.ok) {
    // Human-advanced rows reconcile stale pending state like /extraction-failed
    // (so the month-close gate isn't blocked by a late queue report). A
    // needs_render=0 rejection is a wrong-pipeline report and must NOT touch
    // extraction_state — the row may legitimately be mid-extraction.
    const humanAdvanced =
      row.status !== "captured" && row.status !== "needs_review";
    if (humanAdvanced && row.extraction_state && isPendingState(row.extraction_state)) {
      await db
        .prepare(
          `UPDATE receipt_records
             SET extraction_state = 'processed', updated_at = ?
           WHERE id = ? AND extraction_state IN ('captured','queued','processing')`,
        )
        .bind(now, receiptId)
        .run();
    }
    await createAuditEntry(db, {
      actor,
      action: "receipt.render_failed",
      objectType: "receipt",
      objectId: receiptId,
      newValueJson: stringifyJson({
        reason: "rejected",
        status: row.status,
        failureReason: reason,
      }),
    });
    return { kind: "conflict", error: admission.error };
  }

  const mergedJson = mergeTerminalRenderPayload(row.extraction_json, reason, now);
  // B1/B2: the WHERE re-checks the entire admitted state, so a race that
  // advances, deletes, or terminally marks the receipt between the read and
  // this write yields zero affected rows — handled honestly below.
  const result = await db
    .prepare(
      `UPDATE receipt_records
         SET extraction_state = 'failed',
             extraction_processed_at = ?,
             extraction_json = ?,
             updated_at = ?
       WHERE id = ?
         AND deleted_at IS NULL
         AND needs_render = 1
         AND extraction_state IN ('captured','queued','processing')
         AND status IN ('captured','needs_review')`,
    )
    .bind(now, mergedJson, now, receiptId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    // Admission lost between read and write. If a concurrent report won, the
    // marker it committed is authoritative; otherwise name the conflict.
    const after = await db
      .prepare(
        `SELECT extraction_json, needs_render, extraction_state, status, deleted_at
         FROM receipt_records WHERE id = ?`,
      )
      .bind(receiptId)
      .first<FailureRow>();
    if (!after || after.deleted_at) return { kind: "not_found" };
    if (after.extraction_state === "failed" && after.needs_render === 1) {
      return firstTerminalMarker(after.extraction_json);
    }
    return {
      kind: "conflict",
      error:
        "Receipt changed before the failure could be recorded " +
        `(now status='${after.status}', extraction_state='${after.extraction_state ?? "captured"}'). ` +
        "No terminal state was written.",
    };
  }

  await createAuditEntry(db, {
    actor,
    action: "receipt.render_failed",
    objectType: "receipt",
    objectId: receiptId,
    newValueJson: stringifyJson({ failureReason: reason, stage: "render" }),
  });
  return { kind: "recorded", failedAt: now };
}

/** Extract the first committed terminal marker from extraction_json. */
function firstTerminalMarker(
  extractionJson: string | null,
): { kind: "already_terminal"; reason: string | null; failedAt: string | null } {
  if (!extractionJson) return { kind: "already_terminal", reason: null, failedAt: null };
  try {
    const parsed = JSON.parse(extractionJson) as {
      reason?: unknown;
      failedAt?: unknown;
    };
    return {
      kind: "already_terminal",
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      failedAt: typeof parsed.failedAt === "string" ? parsed.failedAt : null,
    };
  } catch {
    return { kind: "already_terminal", reason: null, failedAt: null };
  }
}

function isPendingState(state: string): boolean {
  return (PENDING_STATES as readonly string[]).includes(state);
}

// ─── Deliberate recovery (retryRender) ───────────────────────────────────────

export type RetryRenderResult =
  | { kind: "retrying" }
  | { kind: "conflict"; error: string }
  | { kind: "not_found" };

/**
 * Canonical month/seal guard for the retry write, as embeddable SQL (review
 * B3): the retry is refused while EITHER canonical lock holds —
 *   1. reconciliation-sealed: the receipt is matched to an AMEX line in a
 *      finalized reconciliation that is still edit-locked (db.ts
 *      rejectIfReceiptInFinalizedReconciliation semantics, incl. the ADR
 *      0012 draft carve-out), or
 *   2. export-finalized: the receipt's transaction month has a finalized
 *      export with no open draft (isMonthLockedForEdits semantics).
 * Undated render-pending rows (the overwhelmingly common case) satisfy
 * neither. The fragment builders live in month-lock.ts so the embedded guard
 * and the JS predicates share one source.
 */
export function retrySealGuardSql(): string {
  return (
    `NOT(${monthLockedForEditsSql("substr(receipt_records.transaction_date, 1, 7)")}) ` +
    `AND NOT ${receiptInFinalizedReconciliationSql("receipt_records.id")}`
  );
}

/**
 * Clear the terminal render-failure marker so the Mac render leg picks the
 * receipt up again (review B3). The admission — including deleted_at, the
 * seal guards above, and the status/state predicates — is enforced INSIDE
 * the single conditional UPDATE; affected rows are inspected. Zero rows
 * changed is re-read and reported honestly (deleted → not_found; raced
 * review/seal/recovery → conflict), never a false success audit.
 *
 * Writes no business fields and never enqueues (render rows enqueue via
 * /render only, after the derivative lands — the intentionally narrow
 * /enqueue contract is untouched).
 */
export async function retryRender(input: {
  db: D1Database;
  receiptId: string;
  actor: string;
  now?: string;
}): Promise<RetryRenderResult> {
  const { db, receiptId, actor } = input;
  const now = input.now ?? nowIso();

  const row = await db
    .prepare(
      `SELECT id, deleted_at, needs_render, extraction_state, status, transaction_date
       FROM receipt_records WHERE id = ?`,
    )
    .bind(receiptId)
    .first<
      FailureRow & { transaction_date: string | null }
    >();
  if (!row || row.deleted_at) return { kind: "not_found" };

  const admission = admitRenderRetry({
    ...row,
    captured_at: null,
  } as unknown as ReceiptRecord);
  if (!admission.ok) return { kind: "conflict", error: admission.error };

  const result = await db
    .prepare(
      `UPDATE receipt_records
         SET extraction_state = 'captured',
             extraction_processed_at = NULL,
             updated_at = ?
       WHERE id = ?
         AND deleted_at IS NULL
         AND needs_render = 1
         AND extraction_state = 'failed'
         AND status IN ('captured','needs_review')
         AND ${retrySealGuardSql()}`,
    )
    .bind(now, receiptId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    const after = await db
      .prepare(
        `SELECT deleted_at, needs_render, extraction_state, status, transaction_date
         FROM receipt_records WHERE id = ?`,
      )
      .bind(receiptId)
      .first<FailureRow & { transaction_date: string | null }>();
    if (!after || after.deleted_at) return { kind: "not_found" };
    if (
      after.needs_render === 1 &&
      after.extraction_state === "failed" &&
      (after.status === "captured" || after.status === "needs_review")
    ) {
      // Admission predicates still hold ⇒ the seal guard refused it.
      const month = after.transaction_date ? after.transaction_date.slice(0, 7) : null;
      return {
        kind: "conflict",
        error:
          `Receipt sits in a sealed month${month ? ` (${month})` : ""} — ` +
          "reopen via the export revision flow before retrying its render.",
      };
    }
    return {
      kind: "conflict",
      error:
        "Receipt changed before the retry could be applied " +
        `(now status='${after.status}', extraction_state='${after.extraction_state ?? "captured"}') — ` +
        "no retry was queued.",
    };
  }

  await createAuditEntry(db, {
    actor,
    action: "receipt.render_retry",
    objectType: "receipt",
    objectId: receiptId,
    newValueJson: stringifyJson({
      previousState: "failed",
      via: "dashboard_health_row",
    }),
  });
  return { kind: "retrying" };
}
