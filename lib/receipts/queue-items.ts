import {
  requiresAttendees as categoryRequiresAttendees,
  getCategoryByCode,
} from "@/lib/receipts/categories";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
import type { ReceiptLockInfo, ReceiptLockKind } from "@/lib/receipts/receipt-locks";
import type { ReceiptRecord } from "@/lib/receipts/types";

/** Audit B6 / Task 4: per-receipt "stuck?" threshold for the review queue.
 *  Receipts pending extraction older than this get an amber badge in the
 *  rail so the operator notices a stalled consumer immediately, not at
 *  month-close. Distinct from STALE_PENDING_MS in extraction-state.ts (20m
 *  header-chip threshold); this is a louder, per-row surface. */
const STUCK_PENDING_MS = 30 * 60 * 1000;

export type QueueItem = {
  id: string;
  merchant: string;
  amountLabel: string;
  dateLabel: string;
  categoryLabel: string;
  status: ReceiptRecord["status"];
  needs: "attendees" | "purpose" | "re-review" | null;
  /** True when this receipt is pending extraction and was enqueued/captured
   *  more than STUCK_PENDING_MS ago. The queue-rail renders an amber
   *  "stuck?" badge to flag a likely-stalled consumer. */
  stuck: boolean;
  /** True when extraction_state === 'failed'. Renders a red "extraction
   *  failed" pill in the queue-rail so the operator sees the receipt needs
   *  manual handling. `failureReason` (when present) is surfaced via the
   *  pill's title attribute. */
  extractionFailed: boolean;
  failureReason: string | null;
  /** Split-lock surface (receipt-locks.ts). A locked receipt is hidden from
   *  the default queue and shown read-only when opened. The rail renders a
   *  gray "sealed" badge when `locked` is set (data-driven, not filter-driven
   *  — only visible under the locked filter in practice). */
  locked: boolean;
  lockKind: ReceiptLockKind | null;
  /** Sortable keys derived from the raw row so Date/Amount sort and "Needs
   *  first" ordering are correct regardless of the formatted label. Date is
   *  epoch-ms (transaction_date, falling back to captured_at); amount is the
   *  raw minor units (-1 when unknown so it sorts low, not as zero). */
  sortDateMs: number;
  sortAmountMinor: number;
};

export function buildQueueItems(
  receipts: ReceiptRecord[],
  reReviewIds: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
  locks: ReadonlyMap<string, ReceiptLockInfo> = new Map(),
): QueueItem[] {
  return receipts.map((r) => {
    const code = r.expense_category_code ?? "";
    const cat = getCategoryByCode(code);
    const captured = r.captured_at ?? "";
    const failure = readFailureInfo(r);
    const lock = locks.get(r.id);
    return {
      id: r.id,
      merchant: r.merchant?.trim() || "Unnamed receipt",
      amountLabel: formatAmount(r.amount_minor, r.currency),
      dateLabel: formatDate(r.transaction_date ?? captured.slice(0, 10)),
      categoryLabel: cat ? cat.enName : code ? code : "Uncategorized",
      status: r.status,
      needs: needsFlag(r, code, reReviewIds.has(r.id)),
      stuck: isStuckPending(r, now),
      extractionFailed: failure.failed,
      failureReason: failure.reason,
      locked: lock?.locked ?? false,
      lockKind: lock?.kind ?? null,
      sortDateMs: sortDateMsFor(r),
      sortAmountMinor: r.amount_minor ?? -1,
    };
  });
}

/** Epoch-ms for the receipt's effective date (transaction_date, falling back
 *  to captured_at — the same fallback dateLabel uses). 0 when unparseable so
 *  undated/legacy rows sort to an end rather than NaN-scattering. */
function sortDateMsFor(r: ReceiptRecord): number {
  const captured = r.captured_at ?? "";
  const raw = r.transaction_date || captured.slice(0, 10);
  if (!raw) return 0;
  const t = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(t) ? 0 : t;
}

/** Parse extraction_json for the failed marker written by
 *  POST /api/receipts/[id]/extraction-failed. Returns null-safe defaults
 *  for receipts that never failed or have a non-JSON / mismatched shape. */
function readFailureInfo(
  r: ReceiptRecord,
): { failed: boolean; reason: string | null } {
  if (r.extraction_state !== "failed") return { failed: false, reason: null };
  if (!r.extraction_json) return { failed: true, reason: null };
  try {
    const parsed = JSON.parse(r.extraction_json) as {
      failed?: boolean;
      reason?: string;
    };
    return {
      failed: true,
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.trim().slice(0, 300)
          : null,
    };
  } catch {
    return { failed: true, reason: null };
  }
}

function isStuckPending(r: ReceiptRecord, now: number): boolean {
  if (!isPendingProcessing(r)) return false;
  // Prefer extraction_enqueued_at (true waiting-since), fall back to
  // captured_at for legacy rows that predate the queue column.
  const since = r.extraction_enqueued_at ?? r.captured_at;
  if (!since) return false;
  const t = Date.parse(since);
  if (Number.isNaN(t)) return false;
  return now - t >= STUCK_PENDING_MS;
}

function needsFlag(
  r: ReceiptRecord,
  code: string,
  reReviewNeeded: boolean,
): "attendees" | "purpose" | "re-review" | null {
  if (r.status === "exported" || r.status === "archived") return null;
  if (reReviewNeeded) return "re-review";
  if (categoryRequiresAttendees(code)) {
    if (!r.business_purpose) return "attendees";
  }
  if (code === "meeting" && !r.business_purpose) return "purpose";
  return null;
}

function formatAmount(amount: number | null, currency: string | null) {
  if (amount == null) return "—";
  if (!currency || currency === "JPY") return `¥${amount.toLocaleString()}`;
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

function formatDate(d: string) {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return d.slice(0, 10);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
