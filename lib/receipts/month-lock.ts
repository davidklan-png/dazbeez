// A small value-object that bundles "is this month finalized?" with the
// metadata UI surfaces need: a label, a reason for the lock, and a date.
// Pages fetch the finalized flag server-side and pass this down so client
// components can disable mutating controls upstream — instead of letting
// the user click a button and discover the 409 in a toast.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { newUuid } from "@/lib/receipts/db-utils";

export type MonthLock = {
  /** True when the month is finalized (no further edits allowed). */
  locked: boolean;
  /** ISO timestamp the reconciliation was sealed, if any. */
  finalizedAt: string | null;
  /** Short label suitable for a Pill or badge ("Sealed" / "Draft"). */
  badge: "Sealed" | "Draft" | "Not built";
  /** One-line reason to surface in tooltips and confirm dialogs. */
  reason: string;
};

export function buildMonthLock(input: {
  finalized: boolean;
  finalizedAt?: string | null;
  hasDraft?: boolean;
}): MonthLock {
  if (input.finalized) {
    return {
      locked: true,
      finalizedAt: input.finalizedAt ?? null,
      badge: "Sealed",
      reason: "This month is finalized. Reopen reconciliation to edit.",
    };
  }
  if (input.hasDraft) {
    return {
      locked: false,
      finalizedAt: null,
      badge: "Draft",
      reason: "Reconciliation is in progress.",
    };
  }
  return {
    locked: false,
    finalizedAt: null,
    badge: "Not built",
    reason: "Reconciliation hasn't been started for this month.",
  };
}

// ─── Split lock model (audit A5, fix F1-F3 2026-07-08) ───────────────────────
//
// Two independent locks govern month-end state, each blocking a different
// kind of edit:
//
//   1. Reconciliation-sealed (existing, in db.ts
//      rejectIfReceiptInFinalizedReconciliation). When a statement month's
//      amex_reconciliation row is status='finalized', every AMEX line — and
//      any receipt matched to one — is immutable. Statement-month scope.
//
//   2. Export-finalized (below). When an export for month M is
//      status='finalized', CASH/DIGITAL receipt edits anchored by
//      transaction_date in M are blocked. A late cash receipt that arrives
//      after its transaction month shipped must go through the export
//      revision flow (POST /api/receipts/export/<month>?correction=true)
//      instead of being inserted/edited directly. Transaction-month scope.
//
// AMEX-path receipts are intentionally NOT gated by the export lock —
// they are governed by (1) via their statement line. CASH/DIGITAL
// receipts are NOT gated by (1) — they have no statement line to match.
// Each lock owns its own population; the two never overlap.
//
// F1 correction (2026-07-08 architecture review): the lock must release
// while a draft revision exists for the month. A finalized export row is
// permanent (preservation principle), so without this carve-out the
// correction flow could never actually correct anything — every edit
// attempt would re-hit the finalized row and re-throw. The predicate
// below treats "has draft revision" as a release of the lock; finalizing
// the revision closes the lock again (draft goes away, finalized stays).
//
// ADR 0012 (2026-07-20) unifies this draft carve-out as the single "month
// open for correction" signal across ALL three edit gates: this export lock
// (#1), the reconciliation lock (#2, for receipt edits only —
// rejectIfReceiptInFinalizedReconciliation in db.ts), and the per-receipt
// status gate (#3 — an `exported` receipt becomes editable/deletable while a
// draft is open, via isMonthLockedForEdits in the PATCH/DELETE paths). The
// line-level reconciliation seal (rejectIfFinalized on amex_statement_lines
// writes) deliberately stays strict. See receipt-locks.ts header +
// docs/adr/0012-unified-draft-carveout-month-locks.md.

/**
 * Typed error thrown when an insert/update would land a CASH/DIGITAL
 * receipt in a month that already has a finalized export and no open
 * draft revision. Routes catch this with `instanceof ExportFinalizedError`
 * instead of brittle string matching against error.message.
 */
export class ExportFinalizedError extends Error {
  constructor(
    /** The YYYY-MM transaction month that is locked. */
    public readonly month: string,
    message: string,
  ) {
    super(message);
    this.name = "ExportFinalizedError";
  }
}

/**
 * Minimal D1 shape this module queries against. Exported so tests can
 * build a fake without depending on the full Cloudflare D1Database type.
 */
export interface MonthLockD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

/**
 * True when an export for `month` exists at status='finalized'. No data
 * from the row is returned — callers only need the boolean.
 *
 * Note: this does NOT account for draft revisions. For "is this month
 * locked for edits?" use {@link isMonthLockedForEdits} instead — that
 * predicate releases the lock while a draft revision exists.
 */
export async function isMonthExportFinalized(month: string): Promise<boolean> {
  const db = getReceiptsDb();
  const row = await db
    .prepare(
      `SELECT 1 FROM receipt_exports
       WHERE export_month = ? AND status = 'finalized'
       LIMIT 1`,
    )
    .bind(month)
    .first<{ "1": number }>();
  return row !== null;
}

/**
 * The actual edit-lock predicate. A month is locked for CASH/DIGITAL
 * receipt edits iff:
 *   - an export exists at status='finalized' for the month, AND
 *   - no export exists at status='draft' for the month.
 *
 * The draft carve-out is what makes the correction flow workable: opening
 * a revision via POST /api/receipts/export/<month>?correction=true creates
 * a fresh draft row, which releases the lock for the duration of the
 * correction. Finalizing the revision (or deleting the draft) re-closes
 * it. One indexed D1 lookup per mutation — acceptable cost, and avoids
 * the stale-cache trap a module-level memo would introduce (F2).
 *
 * Takes `db` as a parameter so tests can fake it without module mocking.
 */
export async function isMonthLockedForEdits(
  db: MonthLockD1,
  month: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT CASE
         WHEN EXISTS(
           SELECT 1 FROM receipt_exports
           WHERE export_month = ? AND status = 'draft'
         ) THEN 0
         WHEN EXISTS(
           SELECT 1 FROM receipt_exports
           WHERE export_month = ? AND status = 'finalized'
         ) THEN 1
         ELSE 0
       END AS locked`,
    )
    .bind(month, month)
    .first<{ locked: 0 | 1 }>();
  return row?.locked === 1;
}

/**
 * Assert that a CASH/DIGITAL receipt can be placed in the given
 * transaction month. Throws ExportFinalizedError when the month is locked
 * for edits (see {@link isMonthLockedForEdits}). Caller must format
 * `transactionMonth` as YYYY-MM (the same format
 * receipt_records.transaction_date stores as YYYY-MM-DD).
 *
 * No-op when `transactionMonth` is null/empty — the lock can't apply
 * until the transaction_date is known (uploads insert with null date
 * and let the extraction backfill it).
 */
export async function assertTransactionMonthEditable(
  transactionMonth: string | null | undefined,
): Promise<void> {
  if (!transactionMonth) return;
  const db = getReceiptsDb();
  if (await isMonthLockedForEdits(db, transactionMonth)) {
    throw new ExportFinalizedError(
      transactionMonth,
      `Month ${transactionMonth} is export-finalized. POST /api/receipts/export/${transactionMonth}?correction=true to create a revision.`,
    );
  }
}

/**
 * Derive the YYYY-MM month key from a YYYY-MM-DD transaction_date. Returns
 * null for null/empty/malformed input so callers can pass the raw column
 * value through without conditional branches.
 */
export function transactionMonthOf(
  transactionDate: string | null | undefined,
): string | null {
  if (!transactionDate) return null;
  const m = /^(\d{4}-\d{2})/.exec(transactionDate);
  return m ? m[1]! : null;
}

/**
 * The YYYY-MM of "now" in the operator's timezone (JST, UTC+9). Used as the
 * review queue's default month scope. JST-aware so a capture late on the 1st
 * (or early-UTC on the 1st = still the 1st in Tokyo) isn't off-by-one against
 * a UTC `toISOString()` slice.
 */
export function currentCalendarMonth(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 7);
}

// ─── Embeddable SQL forms of the canonical locks ─────────────────────────────
//
// The predicates above answer "is month M locked?" from JS, one query at a
// time. Some write paths need the SAME semantics inside a single conditional
// UPDATE (so admission cannot be lost to a race between read and write) —
// e.g. the render-retry recovery write (render-recovery.ts). These builders
// restate the JS functions' table/status predicates, including the ADR 0012
// unified draft carve-out. They are a PARALLEL EXPRESSION, not a shared
// implementation: when either side changes, update the other — the
// export-month cases of the embedded guard are pinned against
// isMonthLockedForEdits by render-recovery's persistence tests.

/**
 * SQL boolean: the month named by `monthExpr` (a SQL expression yielding
 * YYYY-MM, e.g. a bound param or substr(transaction_date,1,7)) is locked for
 * edits — finalized export exists AND no open draft. Mirrors
 * {@link isMonthLockedForEdits}.
 */
export function monthLockedForEditsSql(monthExpr: string): string {
  return (
    `EXISTS(SELECT 1 FROM receipt_exports e ` +
    `WHERE e.export_month = ${monthExpr} AND e.status = 'finalized') ` +
    `AND NOT EXISTS(SELECT 1 FROM receipt_exports d ` +
    `WHERE d.export_month = ${monthExpr} AND d.status = 'draft')`
  );
}

/**
 * SQL boolean: the receipt identified by `receiptIdExpr` is matched to an
 * AMEX line in a statement month whose reconciliation is finalized AND still
 * edit-locked (same draft carve-out). Mirrors
 * rejectIfReceiptInFinalizedReconciliation in db.ts.
 */
export function receiptInFinalizedReconciliationSql(
  receiptIdExpr: string,
): string {
  return (
    `EXISTS(SELECT 1 FROM amex_statement_lines asl ` +
    `JOIN amex_reconciliations ar ` +
    `ON ar.statement_month = asl.statement_month ` +
    `AND ar.status = 'finalized' ` +
    `WHERE asl.matched_receipt_id = ${receiptIdExpr} ` +
    `AND ${monthLockedForEditsSql("ar.statement_month")})`
  );
}

// ─── Build claim (seal boundary, migration 0042) ─────────────────────────────
//
// An ACTIVE build claim is an expiring lease on a receipt_exports DRAFT row:
// sealing_token (a fresh unpredictable build id per attempt) + sealing_expires_at
// (unix epoch seconds, D1-clock derived, SEAL_LEASE_SECONDS ahead). While the
// lease is unexpired, the 0042 triggers fence every protected input to the
// claimed month. Ownership is TOKEN PLUS UNEXPIRED LEASE, never the token
// alone: every predicate in SQL ignores expired claims, so expiry needs no
// write, heals admission automatically, and an expired attempt can never
// publish (the publication CAS requires the unexpired lease in its WHERE).
//
// Ten minutes is a retry limit, not proof the previous Worker died — an
// expired attempt may keep running, but it cannot publish or clear a
// successor's lease.

/** Lease duration in seconds. Derived from D1 time inside the acquisition SQL. */
export const SEAL_LEASE_SECONDS = 600;

/** Typed error for claim contention: an active claim blocks acquisition, or
 *  the row is not an acquirable draft. Routes surface this as 409. */
export class SealClaimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealClaimConflictError";
  }
}

/** Minimal D1 shape the claim helpers need (bindable + first/run). */
export interface ClaimD1 {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      run(): Promise<{ success: true; meta: { changes: number } }>;
    };
  };
}

/**
 * Acquire (or re-acquire over an absent/expired claim) the build lease on a
 * draft export row, in ONE conditional UPDATE — changes=1 or the attempt never
 * starts. The lease expiry is derived from D1 time inside the statement.
 *
 * On finalize, the request's explicit message decision (value + decision
 * timestamp) rides this SAME statement, exactly as updateExportOperatorMessage
 * would write it — so the gate sees a real decision and no separate pre-gate
 * write exists that a claim fence could reject. On rebuild, the stored
 * message/decision are left untouched at acquisition; a supplied override is
 * resolved in memory and published only with successful outputs.
 *
 * Returns the fresh token (also the build id / R2 namespace for this attempt).
 */
export async function acquireSealClaim(
  db: ClaimD1,
  opts: {
    exportId: string;
    finalize: boolean;
    /** Finalize only: the resolved message decision (null = "no message"). */
    operatorMessage?: string | null;
    /** Finalize only: decision timestamp (JS nowIso, like the PATCH route). */
    decisionAt?: string;
    /** TESTS ONLY: lease duration override. A negative value deterministically
     *  models an ALREADY-EXPIRED claim (acquisition over an absent prior claim
     *  is allowed; every predicate then ignores the lease). Production callers
     *  omit it and get SEAL_LEASE_SECONDS. */
    leaseSeconds?: number;
  },
): Promise<string> {
  const token = newUuid();
  const lease = opts.leaseSeconds ?? SEAL_LEASE_SECONDS;
  const leaseExpireExpr = `CAST(strftime('%s','now') AS INTEGER) + ${lease}`;
  const reclaimable = `(sealing_token IS NULL OR sealing_expires_at IS NULL OR sealing_expires_at <= CAST(strftime('%s','now') AS INTEGER))`;
  const result = opts.finalize
    ? await db
        .prepare(
          `UPDATE receipt_exports
             SET sealing_token = ?,
                 sealing_expires_at = ${leaseExpireExpr},
                 operator_message = ?,
                 operator_message_updated_at = ?
           WHERE id = ? AND status = 'draft' AND ${reclaimable}`,
        )
        .bind(token, opts.operatorMessage ?? null, opts.decisionAt ?? null, opts.exportId)
        .run()
    : await db
        .prepare(
          `UPDATE receipt_exports
             SET sealing_token = ?,
                 sealing_expires_at = ${leaseExpireExpr}
           WHERE id = ? AND status = 'draft' AND ${reclaimable}`,
        )
        .bind(token, opts.exportId)
        .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new SealClaimConflictError(
      `Another build is already in progress for this month (or the draft is no longer acquirable). Retry in a moment.`,
    );
  }
  return token;
}

/**
 * Conditionally release an OWNED claim (ID + token), so a loser can never
 * clear a successor's lease. Never touches a finalized row or another
 * attempt's claim: the WHERE matches only this exact token on a draft.
 */
export async function releaseSealClaim(
  db: ClaimD1,
  exportId: string,
  token: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE receipt_exports
         SET sealing_token = NULL, sealing_expires_at = NULL
       WHERE id = ? AND sealing_token = ? AND status = 'draft'`,
    )
    .bind(exportId, token)
    .run();
}

// ─── Friendly conflict mapping (stable ASCII identifiers) ────────────────────
//
// The 0042 triggers RAISE stable ASCII identifiers (DZ_SEAL_*); drivers wrap
// them in vendor-specific text (e.g. "D1_ERROR: DZ_SEAL_CLAIM_ACTIVE:receipt_
// records: SQLITE_CONSTRAINT…"). Match ONLY the identifier, never a full
// message, and map every seal-boundary rejection to a 409 conflict response.

const SEAL_BOUNDARY_CODE = /DZ_SEAL_[A-Z_]+/;

/** The stable trigger identifier carried by this error, or null. */
export function sealBoundaryErrorCode(error: unknown): string | null {
  if (error instanceof Error) {
    const m = SEAL_BOUNDARY_CODE.exec(error.message);
    if (m) return m[0];
  }
  return null;
}

/** True when this error is a seal-boundary trigger rejection (→ 409). */
export function isSealBoundaryConflict(error: unknown): boolean {
  return sealBoundaryErrorCode(error) !== null;
}

/** The active-build-claim rejection's stable identifier (see DZ_SEAL_* codes). */
export const SEAL_CLAIM_ACTIVE_CODE = "DZ_SEAL_CLAIM_ACTIVE" as const;

/**
 * True when this error is specifically the ACTIVE-BUILD-CLAIM rejection — a
 * TEMPORARY condition (lease ≤ SEAL_LEASE_SECONDS). Processor-facing
 * boundaries (e.g. /extract) must classify it RETRYABLE (5xx + Retry-After),
 * not 409: the Mac consumer treats every 4xx as terminal and would ack+drop
 * work that only needed to wait out a monthly build.
 */
export function isTemporaryClaimConflict(error: unknown): boolean {
  return sealBoundaryErrorCode(error) === SEAL_CLAIM_ACTIVE_CODE;
}
