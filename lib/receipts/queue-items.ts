import {
  requiresAttendees as categoryRequiresAttendees,
  getCategoryByCode,
} from "@/lib/receipts/categories";
import type { ReceiptRecord } from "@/lib/receipts/types";

export type QueueItem = {
  id: string;
  merchant: string;
  amountLabel: string;
  dateLabel: string;
  categoryLabel: string;
  status: ReceiptRecord["status"];
  needs: "attendees" | "purpose" | null;
};

export function buildQueueItems(receipts: ReceiptRecord[]): QueueItem[] {
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
      needs: needsFlag(r, code),
    };
  });
}

function needsFlag(
  r: ReceiptRecord,
  code: string,
): "attendees" | "purpose" | null {
  if (r.status === "exported" || r.status === "archived") return null;
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
