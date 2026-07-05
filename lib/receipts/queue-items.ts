import {
  requiresAttendees as categoryRequiresAttendees,
  getCategoryByCode,
} from "@/lib/receipts/categories";
import { isPendingProcessing } from "@/lib/receipts/extraction-state";
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
};

export function buildQueueItems(
  receipts: ReceiptRecord[],
  reReviewIds: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
): QueueItem[] {
  return receipts.map((r) => {
    const code = r.expense_category_code ?? "";
    const cat = getCategoryByCode(code);
    const captured = r.captured_at ?? "";
    return {
      id: r.id,
      merchant: r.merchant?.trim() || "Unnamed receipt",
      amountLabel: formatAmount(r.amount_minor, r.currency),
      dateLabel: formatDate(r.transaction_date ?? captured.slice(0, 10)),
      categoryLabel: cat ? cat.enName : code ? code : "Uncategorized",
      status: r.status,
      needs: needsFlag(r, code, reReviewIds.has(r.id)),
      stuck: isStuckPending(r, now),
    };
  });
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
