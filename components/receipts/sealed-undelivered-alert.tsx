import Link from "next/link";
import {
  deliveryStateToPill,
  type DeliveryState,
} from "@/lib/receipts/delivery-state";
import { formatMonthJa } from "@/lib/receipts/format";

/**
 * Dashboard banner listing every finalized month that is NOT yet delivered
 * (delivery-composer §6, surface 2). Modelled on pipeline-health-alert for
 * visual consistency. Each month links to its composer. Returns null when every
 * finalized month is delivered (the all-clear state). Pure server component.
 *
 * "Sealed-undelivered" here is the broad, actionable reading: sealed_undelivered
 * (failed), pending (in-flight), and null (sealed, never attempted) all leave the
 * month not-yet-closed-for-reporting. The per-month label distinguishes them.
 */
export function SealedUndeliveredAlert({
  months,
}: {
  months: { month: string; state: DeliveryState | null }[];
}) {
  if (months.length === 0) return null;

  return (
    <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm">
      <p className="font-semibold text-red-800">
        送信待ちの確定済み月があります
      </p>
      <p className="mt-0.5 text-[12px] text-red-700">
        これらの月は確定（seal）済みですが、会計士への送信が完了していません。レポート用のクローズには送信が必要です。
      </p>
      <ul className="mt-2 space-y-1">
        {months.map(({ month, state }) => {
          const pill = deliveryStateToPill(state);
          const label =
            pill === "pending"
              ? "送信中"
              : state === null
                ? "未送信（送信未実行）"
                : "送信失敗（再送信可）";
          return (
            <li key={month} className="flex items-center gap-2 text-[13px]">
              <Link
                href={`/receipts/export/${month}/send`}
                className="font-semibold text-red-800 underline hover:text-red-900"
              >
                {formatMonthJa(month)}
              </Link>
              <span className="text-red-600">· {label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
