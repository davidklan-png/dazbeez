// Capture-pipeline health surface (backlog #19).
//
// Four failure classes, derived cheaply from receipt_records (+ receipt_files
// for class 4). Designed to catch exactly what 2026-08-09 hid for six days: a
// receipt no consumer will ever see (class 1) and a receipt with no manifest
// row that silently blocks month finalize (class 4). Classes 2/3 detect a
// stalled consumer / render leg by age.
//
// Pure pieces (summarizePipelineHealth + buildPipelineClassQuery) are unit-
// tested; getPipelineHealth is the D1 runner. Supersedes the old
// getExtractionHealth (extraction-state.ts), which was row-based, covered only
// ~class 2, and — because it built on pendingProcessingReceipts (which excludes
// needs_render) — could not see class 3. That function and its test are deleted.

import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { readFailureInfo } from "@/lib/receipts/queue-items";

/** Consumer launchd interval is 600s; 20 min of unprocessed backlog means it is
 *  not draining. Same threshold the deleted getExtractionHealth used. */
export const STALE_PENDING_MS = 20 * 60 * 1000;

export type PipelineClassKind =
  | "never_enqueued"
  | "consumer_stalled"
  | "render_stalled"
  | "missing_manifest"
  | "render_failed"
  | "extraction_failed";

export type PipelineSeverity = "error" | "warn";

/** Raw per-class signal from a COUNT(*) + MIN(...) query. */
export interface PipelineClassSignal {
  count: number;
  /** Age of the oldest affected receipt, ms. null when count === 0. */
  oldestAgeMs: number | null;
}

export interface PipelineClassReport extends PipelineClassSignal {
  kind: PipelineClassKind;
  severity: PipelineSeverity;
  /** Actionable one-liner: "3 receipts will never be processed (oldest 6d)". */
  summary: string;
}

export interface PipelineHealth {
  /** true iff no class is lit (the dashboard renders nothing). */
  ok: boolean;
  /** Only classes with count > 0; errors before warns. */
  lit: PipelineClassReport[];
}

/** Sentinel for the dashboard's failure fallback (a health check that crashes
 *  the page is worse than none). */
export const PIPELINE_ALL_CLEAR: PipelineHealth = { ok: true, lit: [] };

interface ClassMeta {
  severity: PipelineSeverity;
  /** Full noun phrase including the count, pluralized. */
  text: (count: number) => string;
}

const CLASS_META: Record<PipelineClassKind, ClassMeta> = {
  never_enqueued: {
    severity: "error",
    text: (n) => `${n} ${n === 1 ? "receipt" : "receipts"} will never be processed`,
  },
  consumer_stalled: {
    severity: "warn",
    text: (n) =>
      `${n} ${n === 1 ? "receipt" : "receipts"} waiting on a stalled consumer`,
  },
  render_stalled: {
    severity: "warn",
    text: (n) =>
      `${n} ${n === 1 ? "receipt" : "receipts"} waiting on a stalled render leg`,
  },
  missing_manifest: {
    severity: "error",
    text: (n) =>
      `${n} ${n === 1 ? "receipt" : "receipts"} missing their manifest row (blocks finalize)`,
  },
  // Backlog #22: terminal failures. Distinguished by needs_render (the row
  // itself is the discriminator; extraction_json only carries the reason).
  render_failed: {
    severity: "error",
    text: (n) =>
      `${n} email-body ${n === 1 ? "receipt" : "receipts"} failed rendering permanently (terminal)`,
  },
  extraction_failed: {
    severity: "error",
    text: (n) =>
      `${n} ${n === 1 ? "receipt" : "receipts"} failed extraction permanently (terminal)`,
  },
};

/** Format an age in ms as a short label (12m / 3h / 6d). Pure. */
export function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * Pure summarizer: turns per-class COUNT/age signals into the dashboard report.
 * No I/O, no Date — fully unit-testable. Errors sort before warns.
 */
export function summarizePipelineHealth(input: {
  neverEnqueued: PipelineClassSignal;
  consumerStalled: PipelineClassSignal;
  renderStalled: PipelineClassSignal;
  missingManifest: PipelineClassSignal;
  renderFailed: PipelineClassSignal;
  extractionFailed: PipelineClassSignal;
}): PipelineHealth {
  const order: PipelineClassKind[] = [
    "never_enqueued",
    "missing_manifest",
    "render_failed",
    "extraction_failed",
    "consumer_stalled",
    "render_stalled",
  ];
  const lit: PipelineClassReport[] = [];
  for (const kind of order) {
    const sig = input[classSignalKey(kind)];
    if (sig.count <= 0) continue;
    const meta = CLASS_META[kind];
    const ageSuffix =
      sig.oldestAgeMs != null && sig.oldestAgeMs > 0
        ? ` (oldest ${formatAge(sig.oldestAgeMs)})`
        : "";
    lit.push({
      kind,
      severity: meta.severity,
      count: sig.count,
      oldestAgeMs: sig.oldestAgeMs,
      summary: `${meta.text(sig.count)}${ageSuffix}`,
    });
  }
  // Errors first (already grouped by `order` placing errors early, but sort
  // explicitly so the contract doesn't depend on `order`'s arrangement).
  const rank: Record<PipelineSeverity, number> = { error: 0, warn: 1 };
  lit.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { ok: lit.length === 0, lit };
}

/** Map a class kind to its input key in summarizePipelineHealth's arg. */
function classSignalKey(kind: PipelineClassKind): keyof {
  neverEnqueued: PipelineClassSignal;
  consumerStalled: PipelineClassSignal;
  renderStalled: PipelineClassSignal;
  missingManifest: PipelineClassSignal;
  renderFailed: PipelineClassSignal;
  extractionFailed: PipelineClassSignal;
} {
  switch (kind) {
    case "never_enqueued":
      return "neverEnqueued";
    case "consumer_stalled":
      return "consumerStalled";
    case "render_stalled":
      return "renderStalled";
    case "missing_manifest":
      return "missingManifest";
    case "render_failed":
      return "renderFailed";
    case "extraction_failed":
      return "extractionFailed";
  }
}

/**
 * Pure SQL spec for one pipeline class. Extracted so the predicates are unit-
 * testable (the needs_render exclusion and the strict `<` age threshold are the
 * parts that matter). Bindings are in D1 bind order.
 */
export function buildPipelineClassQuery(
  kind: PipelineClassKind,
  staleBeforeIso: string,
): { sql: string; bindings: readonly unknown[] } {
  switch (kind) {
    // Class 1 (error): captured, never enqueued, not awaiting render. A receipt
    // the consumer will NEVER see — not "slow". needs_render=1 rows are excluded
    // (they wait for /render, not the consumer — they are class 3 if stalled).
    case "never_enqueued":
      return {
        sql: `SELECT COUNT(*) AS n, MIN(captured_at) AS oldest_at
              FROM receipt_records
              WHERE deleted_at IS NULL
                AND extraction_state = 'captured'
                AND extraction_enqueued_at IS NULL
                AND (needs_render = 0 OR needs_render IS NULL)`,
        bindings: [],
      };
    // Class 2 (warn): pending + enqueued, but older than the stall threshold.
    // Disjoint from class 1 (this requires enqueued_at NOT NULL).
    case "consumer_stalled":
      return {
        sql: `SELECT COUNT(*) AS n, MIN(extraction_enqueued_at) AS oldest_at
              FROM receipt_records
              WHERE deleted_at IS NULL
                AND extraction_state IN ('captured','queued','processing')
                AND extraction_enqueued_at IS NOT NULL
                AND extraction_enqueued_at < ?`,
        bindings: [staleBeforeIso],
      };
    // Class 3 (warn): awaiting a Mac render, older than the stall threshold.
    // process_renders logs transient failures to stderr ONLY — this is the
    // only D1 signal for them. Terminal render failures (extraction_state
    // ='failed') are excluded: they are class render_failed, not stalled.
    case "render_stalled":
      return {
        sql: `SELECT COUNT(*) AS n, MIN(captured_at) AS oldest_at
              FROM receipt_records
              WHERE deleted_at IS NULL
                AND needs_render = 1
                AND (extraction_state IS NULL OR extraction_state != 'failed')
                AND captured_at < ?`,
        bindings: [staleBeforeIso],
      };
    // Class 4 (error): has an original_r2_key but zero receipt_files rows →
    // missing the manifest that the proofs gate counts (countReceiptFilesByObjectIds).
    case "missing_manifest":
      return {
        sql: `SELECT COUNT(*) AS n, MIN(rr.captured_at) AS oldest_at
              FROM receipt_records rr
              WHERE rr.deleted_at IS NULL
                AND rr.original_r2_key IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM receipt_files rf
                  WHERE rf.object_type = 'receipt' AND rf.object_id = rr.id
                )`,
        bindings: [],
      };
    // Class 5 (error, backlog #22): terminal RENDER failure — the receipt's
    // email body failed to render permanently. needs_render=1 is what makes
    // this a render failure rather than an extraction failure; the reason
    // lives in extraction_json (stage:'render'). Oldest = when it went
    // terminal (extraction_processed_at, set by the terminal reconcile).
    case "render_failed":
      return {
        sql: `SELECT COUNT(*) AS n, MIN(extraction_processed_at) AS oldest_at
              FROM receipt_records
              WHERE deleted_at IS NULL
                AND extraction_state = 'failed'
                AND needs_render = 1`,
        bindings: [],
      };
    // Class 6 (error): terminal EXTRACTION failure (corrupt image/PDF,
    // zero-byte download — marked by the consumer's permanent classifier).
    // Disjoint from class 5 on needs_render.
    case "extraction_failed":
      return {
        sql: `SELECT COUNT(*) AS n, MIN(extraction_processed_at) AS oldest_at
              FROM receipt_records
              WHERE deleted_at IS NULL
                AND extraction_state = 'failed'
                AND (needs_render = 0 OR needs_render IS NULL)`,
        bindings: [],
      };
  }
}

async function runClassSignal(
  db: D1Database,
  kind: PipelineClassKind,
  staleBeforeIso: string,
  now: number,
): Promise<PipelineClassSignal> {
  const { sql, bindings } = buildPipelineClassQuery(kind, staleBeforeIso);
  const row = await db
    .prepare(sql)
    .bind(...bindings)
    .first<{ n: number; oldest_at: string | null }>();
  const count = row?.n ?? 0;
  if (count <= 0) return { count: 0, oldestAgeMs: null };
  const oldestAgeMs = row?.oldest_at ? now - Date.parse(row.oldest_at) : null;
  return { count, oldestAgeMs };
}

/**
 * Cheap pipeline health: four COUNT(*) + MIN(...) queries, run in parallel.
 * No row loads. Use on the dashboard render; the ~38ms/request CPU budget note
 * in AGENTS.md applies — the added cost is D1 round-trips (parallel), not Worker
 * CPU.
 */
export async function getPipelineHealth(
  db: D1Database = getReceiptsDb(),
  now: number = Date.now(),
): Promise<PipelineHealth> {
  const staleBeforeIso = new Date(now - STALE_PENDING_MS).toISOString();
  const [
    neverEnqueued,
    consumerStalled,
    renderStalled,
    missingManifest,
    renderFailed,
    extractionFailed,
  ] = await Promise.all([
    runClassSignal(db, "never_enqueued", staleBeforeIso, now),
    runClassSignal(db, "consumer_stalled", staleBeforeIso, now),
    runClassSignal(db, "render_stalled", staleBeforeIso, now),
    runClassSignal(db, "missing_manifest", staleBeforeIso, now),
    runClassSignal(db, "render_failed", staleBeforeIso, now),
    runClassSignal(db, "extraction_failed", staleBeforeIso, now),
  ]);
  return summarizePipelineHealth({
    neverEnqueued,
    consumerStalled,
    renderStalled,
    missingManifest,
    renderFailed,
    extractionFailed,
  });
}

// ─── Per-receipt detail rows (backlog #19/#22) ───────────────────────────────
//
// Counts alone don't let the operator ACT. For every lit class except
// missing_manifest (whose fix path is a separate backlog item), the dashboard
// loads the affected receipts with filename, review link, age, reason (the
// terminal classes), and the honest next action — rendered by
// PipelineHealthAlert.

/** Classes that get per-receipt detail rows. missing_manifest is excluded:
 *  its remedy (backfill/re-upload investigation) is a separate flow, not a
 *  per-receipt button or explanation the dashboard can own here. */
export type PipelineDetailKind = Exclude<PipelineClassKind, "missing_manifest">;

/** One affected receipt for the dashboard health rows. `ageMs` is computed at
 *  load time; `reason` is only set for the terminal classes. */
export interface PipelineAttentionReceipt {
  id: string;
  original_filename: string | null;
  ageMs: number;
  reason: string | null;
}

/** Detail rows for one lit class, plus the uncapped total (N1: the loader is
 *  bounded to the oldest MAX_DETAIL_ROWS; `total` lets the surface say
 *  "showing oldest 50 of 51"). `unavailable` is the honest error sentinel —
 *  a failed detail query is NOT an empty list (review B5). */
export const MAX_DETAIL_ROWS = 50;

export interface PipelineAttention {
  kind: PipelineDetailKind;
  rows: PipelineAttentionReceipt[];
  /** Total affected rows for the class (≥ rows.length). */
  total: number;
  /** True when the detail query FAILED — rows must not be treated as the
   *  complete affected set (nor as "none affected": the count is lit). */
  unavailable?: boolean;
}

interface AttentionRow {
  id: string;
  original_filename: string | null;
  /** Timestamp the class ages from: captured_at (1/3), extraction_enqueued_at
   *  (2), or extraction_processed_at (5/6 — when it went terminal). */
  age_from: string | null;
  extraction_state: string | null;
  needs_render: number | null;
  /** Only selected for the terminal classes (they alone read the reason). */
  extraction_json?: string | null;
  /** COUNT(*) OVER () — total affected rows for the class. */
  total: number;
}

/** True for the terminal classes, which surface extraction_json's failure
 *  reason; the stalled/never-enqueued classes never read it, so the detail
 *  query skips the column for them (N1). */
function kindUsesFailureReason(kind: PipelineDetailKind): boolean {
  return kind === "render_failed" || kind === "extraction_failed";
}

/** Pure SQL spec for one class's detail rows. Bindings in D1 bind order. */
export function buildPipelineDetailQuery(
  kind: PipelineDetailKind,
  staleBeforeIso: string,
): { sql: string; bindings: readonly unknown[] } {
  switch (kind) {
    case "never_enqueued":
      return {
        sql: DETAIL_PREFIX(kind) + `
         AND extraction_state = 'captured'
         AND extraction_enqueued_at IS NULL
         AND (needs_render = 0 OR needs_render IS NULL)
       ORDER BY captured_at ASC LIMIT ${MAX_DETAIL_ROWS}`,
        bindings: [],
      };
    case "consumer_stalled":
      return {
        sql: DETAIL_PREFIX(kind) + `
         AND extraction_state IN ('captured','queued','processing')
         AND extraction_enqueued_at IS NOT NULL
         AND extraction_enqueued_at < ?
       ORDER BY extraction_enqueued_at ASC LIMIT ${MAX_DETAIL_ROWS}`,
        bindings: [staleBeforeIso],
      };
    case "render_stalled":
      return {
        sql: DETAIL_PREFIX(kind) + `
         AND needs_render = 1
         AND (extraction_state IS NULL OR extraction_state != 'failed')
         AND captured_at < ?
       ORDER BY captured_at ASC LIMIT ${MAX_DETAIL_ROWS}`,
        bindings: [staleBeforeIso],
      };
    case "render_failed":
      return {
        sql: DETAIL_PREFIX(kind) + `
         AND extraction_state = 'failed'
         AND needs_render = 1
       ORDER BY extraction_processed_at ASC LIMIT ${MAX_DETAIL_ROWS}`,
        bindings: [],
      };
    case "extraction_failed":
      return {
        sql: DETAIL_PREFIX(kind) + `
         AND extraction_state = 'failed'
         AND (needs_render = 0 OR needs_render IS NULL)
       ORDER BY extraction_processed_at ASC LIMIT ${MAX_DETAIL_ROWS}`,
        bindings: [],
      };
  }
}

const DETAIL_PREFIX = (kind: PipelineDetailKind): string => `SELECT id, original_filename,
         CASE
           WHEN extraction_state = 'failed' THEN extraction_processed_at
           WHEN extraction_enqueued_at IS NOT NULL THEN extraction_enqueued_at
           ELSE captured_at
         END AS age_from,
         extraction_state, needs_render${kindUsesFailureReason(kind) ? ", extraction_json" : ""},
         COUNT(*) OVER () AS total
       FROM receipt_records
       WHERE deleted_at IS NULL`;

/** The affected receipts for a lit class (filename, age, reason) plus the
 *  uncapped total. Only load when the class is lit — bounded to the oldest
 *  MAX_DETAIL_ROWS; these are rare error cases. Throws on query failure —
 *  the dashboard maps that to the `unavailable` sentinel (B5), not []. */
export async function listPipelineAttentionReceipts(
  kind: PipelineDetailKind,
  db: D1Database = getReceiptsDb(),
  now: number = Date.now(),
): Promise<PipelineAttention> {
  const staleBeforeIso = new Date(now - STALE_PENDING_MS).toISOString();
  const { sql, bindings } = buildPipelineDetailQuery(kind, staleBeforeIso);
  const result = await db.prepare(sql).bind(...bindings).all<AttentionRow>();
  const rows = (result.results ?? []).map((row) => ({
    id: row.id,
    original_filename: row.original_filename,
    ageMs: row.age_from ? Math.max(0, now - Date.parse(row.age_from)) : 0,
    reason: kindUsesFailureReason(kind)
      ? readFailureInfo({
          extraction_state: row.extraction_state,
          extraction_json: row.extraction_json ?? null,
        }).reason
      : null,
  }));
  return { kind, rows, total: rows.length > 0 ? (result.results?.[0]?.total ?? rows.length) : 0 };
}

// ─── Health-row action failure classification (review R4) ────────────────────

/** Why a health-row action endpoint failed. Pure — the component maps the
 *  HTTP status to one of these before rendering, so the classification is
 *  unit-testable without a DOM. */
export type ActionFailureKind = "refused" | "removed" | "auth" | "temporary";

/**
 * Classify a health-row action failure (Enqueue / Retry render):
 *   409 → refused   (the endpoint's own validated message is shown; the
 *                    action is prohibited in the current state — disabled
 *                    until the page is refreshed)
 *   404 → removed   (the receipt no longer exists — stale dashboard row)
 *   401/403 → auth  (session lost — sign in again)
 *   anything else, incl. 5xx → temporary (transport/server; safe to retry)
 * Network-level failures (fetch threw) are classified by the caller as
 * `temporary` — no status exists to classify.
 */
export function classifyActionFailure(status: number): ActionFailureKind {
  if (status === 409) return "refused";
  if (status === 404) return "removed";
  if (status === 401 || status === 403) return "auth";
  return "temporary";
}

/**
 * True when the action button must be DISABLED after this failure kind.
 * Only `temporary` leaves the action enabled — retrying a refused action is
 * prohibited, a removed receipt cannot be acted on, and an unauthenticated
 * click cannot succeed. `null` (no failure yet / idle) stays enabled.
 */
export function isActionDisabledByFailure(kind: ActionFailureKind | null): boolean {
  return kind !== null && kind !== "temporary";
}
