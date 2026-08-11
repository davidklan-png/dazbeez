import Link from "next/link";
import {
  deliveryStateToPill,
  type DeliveryState,
} from "@/lib/receipts/delivery-state";

/**
 * Per-month delivery banner for the export page (delivery-composer §6, surface
 * 1). Rendered above the sealed-bundle panel ONLY when the month has a sealed
 * (finalized) export. Red + a 送信する link to the composer when sealed-
 * undelivered (failed or never attempted — 2026-06 today); blue when pending
 * (in-flight); green confirmation line when delivered. Sealing ≠ closing
 * (decision 5): the red state says explicitly the month is sealed but not yet
 * closed for reporting. Pure server component (links only, no interactivity).
 */
export function DeliveryMonthBanner({
  month,
  monthLabel,
  state,
}: {
  month: string;
  monthLabel: string;
  state: DeliveryState | null;
}) {
  const pill = deliveryStateToPill(state);

  if (pill === "delivered") {
    return (
      <div className="border-t border-green-200 bg-green-50 px-8 py-4 text-[13px] text-green-800">
        <strong>送信済み</strong> — {monthLabel} は会計士宛てに配信済みです。レポート用のクローズ処理が完了しています。
      </div>
    );
  }

  if (pill === "pending") {
    return (
      <div className="border-t border-blue-200 bg-blue-50 px-8 py-4 text-[13px] text-blue-800">
        <strong>送信中</strong> — {monthLabel} の配信が進行中です。完了までしばらくお待ちください。
      </div>
    );
  }

  // undelivered (sealed_undelivered OR null = sealed, never attempted)
  const neverAttempted = state === null;
  return (
    <div className="border-t border-red-200 bg-red-50 px-8 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[13px] text-red-800">
          <strong>未送信 — 未クローズ</strong> — {monthLabel} は確定（seal）済みですが
          {neverAttempted ? "一度も送信されていません" : "前回の送信に失敗しました"}。
          この月は送信完了までレポート用にクローズされません。
        </div>
        <Link
          href={`/receipts/export/${month}/send`}
          className="shrink-0 rounded-xl bg-amber-500 px-4 py-2 text-[12px] font-semibold text-white hover:bg-amber-600"
        >
          送信する →
        </Link>
      </div>
    </div>
  );
}
