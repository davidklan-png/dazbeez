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

/** Consumer launchd interval is 600s; 20 min of unprocessed backlog means it is
 *  not draining. Same threshold the deleted getExtractionHealth used. */
export const STALE_PENDING_MS = 20 * 60 * 1000;

export type PipelineClassKind =
  | "never_enqueued"
  | "consumer_stalled"
  | "render_stalled"
  | "missing_manifest";

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
}): PipelineHealth {
  const order: PipelineClassKind[] = [
    "never_enqueued",
    "missing_manifest",
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
    // process_renders logs failures to stderr ONLY — this is the only D1 signal.
    case "render_stalled":
      return {
        sql: `SELECT COUNT(*) AS n, MIN(captured_at) AS oldest_at
              FROM receipt_records
              WHERE deleted_at IS NULL
                AND needs_render = 1
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
  const [neverEnqueued, consumerStalled, renderStalled, missingManifest] =
    await Promise.all([
      runClassSignal(db, "never_enqueued", staleBeforeIso, now),
      runClassSignal(db, "consumer_stalled", staleBeforeIso, now),
      runClassSignal(db, "render_stalled", staleBeforeIso, now),
      runClassSignal(db, "missing_manifest", staleBeforeIso, now),
    ]);
  return summarizePipelineHealth({
    neverEnqueued,
    consumerStalled,
    renderStalled,
    missingManifest,
  });
}

/** A class-1 receipt row for the dashboard's per-receipt Enqueue action. */
export interface NeverEnqueuedReceipt {
  id: string;
  captured_at: string | null;
  original_filename: string | null;
}

/** The class-1 receipts. Only load when class 1 is lit — bounded (these are
 *  rare error cases). */
export async function listNeverEnqueuedReceipts(
  db: D1Database = getReceiptsDb(),
): Promise<NeverEnqueuedReceipt[]> {
  const result = await db
    .prepare(
      `SELECT id, captured_at, original_filename
       FROM receipt_records
       WHERE deleted_at IS NULL
         AND extraction_state = 'captured'
         AND extraction_enqueued_at IS NULL
         AND (needs_render = 0 OR needs_render IS NULL)
       ORDER BY captured_at ASC
       LIMIT 50`,
    )
    .all<{ id: string; captured_at: string | null; original_filename: string | null }>();
  return result.results ?? [];
}
