// Pending-processing helpers (ADR 0001).
//
// A captured receipt sits in the extraction queue until the Mac MLX consumer
// processes it. Until then it has no merchant/amount/date key and cannot be
// matched to an AMEX line — so it is NOT a "missing receipt", it is "pending
// processing". This is a first-class state the review/reconcile UI and the
// month-close gate must reason about, per ADR 0001.

import { PENDING_EXTRACTION_STATES, type ReceiptRecord } from "@/lib/receipts/types";

/**
 * True if the receipt is captured but not yet processed by the model.
 *
 * Prefers the explicit `extraction_state`; falls back to `status === 'captured'`
 * for rows written before 0016 / by clients that don't set the column.
 */
export function isPendingProcessing(receipt: ReceiptRecord): boolean {
  if (receipt.extraction_state) {
    return PENDING_EXTRACTION_STATES.includes(receipt.extraction_state);
  }
  return receipt.status === "captured";
}

/** Receipts still waiting on the model. */
export function pendingProcessingReceipts(receipts: ReceiptRecord[]): ReceiptRecord[] {
  return receipts.filter(isPendingProcessing);
}

// ─── Processor health (ADR 0001) ─────────────────────────────────────────────
//
// OCR runs only on the Mac MLX consumer; the Worker just enqueues. SPOF on the
// Mac is accepted by design — so the one thing the UI must surface is the
// binary "is that processor draining the queue, or has it stalled?". We infer
// it from the rows themselves (no extra service): if a pending receipt has been
// waiting longer than the consumer's drain interval with comfortable margin,
// the processor is effectively down. launchd runs the consumer every 600s, so
// 20 minutes of unprocessed backlog means it is not running.
const STALE_PENDING_MS = 20 * 60 * 1000;

export type ExtractionHealthLevel = "ok" | "stalled";

export interface ExtractionHealth {
  /** false when the processor appears to have stopped draining the queue. */
  ok: boolean;
  level: ExtractionHealthLevel;
  /** Receipts captured but not yet processed. */
  pendingCount: number;
  /** Age of the oldest unprocessed receipt, ms (null when none pending). */
  oldestPendingAgeMs: number | null;
  /** Most recent successful processor write, ISO (null if never). */
  lastProcessedAt: string | null;
  /** One-line, human-readable status for the header chip. */
  reason: string;
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * Summarise OCR-processor health from the current receipt set. Pure and
 * timezone-agnostic (pass `now` in tests). Answers one question: are the OCR
 * components working — i.e. is the queue draining — or not?
 */
export function getExtractionHealth(
  receipts: ReceiptRecord[],
  now: number = Date.now(),
): ExtractionHealth {
  const pending = pendingProcessingReceipts(receipts);

  let oldestPendingAgeMs: number | null = null;
  for (const r of pending) {
    // When the row was enqueued is the truest "waiting since"; fall back to
    // capture time for legacy rows that predate the queue column.
    const since = r.extraction_enqueued_at ?? r.captured_at;
    const t = since ? Date.parse(since) : NaN;
    if (Number.isNaN(t)) continue;
    const age = now - t;
    if (oldestPendingAgeMs === null || age > oldestPendingAgeMs) {
      oldestPendingAgeMs = age;
    }
  }

  let lastProcessedAt: string | null = null;
  for (const r of receipts) {
    const p = r.extraction_processed_at;
    if (!p) continue;
    if (!lastProcessedAt || Date.parse(p) > Date.parse(lastProcessedAt)) {
      lastProcessedAt = p;
    }
  }

  const stalled =
    oldestPendingAgeMs !== null && oldestPendingAgeMs >= STALE_PENDING_MS;

  const reason = stalled
    ? `Processor stalled — ${pending.length} waiting, oldest ${formatAge(
        oldestPendingAgeMs!,
      )}`
    : pending.length > 0
      ? `Processing — ${pending.length} in queue`
      : "Up to date";

  return {
    ok: !stalled,
    level: stalled ? "stalled" : "ok",
    pendingCount: pending.length,
    oldestPendingAgeMs,
    lastProcessedAt,
    reason,
  };
}
