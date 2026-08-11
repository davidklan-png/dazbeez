import { notFound } from "next/navigation";
import Link from "next/link";
import { composeDelivery, NoSealedExportError } from "@/lib/receipts/delivery-compose";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { formatMonthJa } from "@/lib/receipts/format";
import { DeliveryComposer } from "@/components/receipts/export/delivery-composer";

export const dynamic = "force-dynamic";

type Params = Promise<{ month: string }>;

/**
 * Delivery composer — /receipts/export/{month}/send.
 *
 * The missing last mile (finalize → review email → send). The delivery backend
 * (POST .../send) had no UI; this page is it. A server component that composes
 * the delivery through the SAME {@link composeDelivery} the send route and the
 * preview endpoint use — the body the operator reads here is byte-identical to
 * the body the send route will emit. The client {@link DeliveryComposer} handles
 * the two-step confirm + in-flight send states; it posts an EMPTY body (the send
 * route composes everything server-side).
 */
export default async function SendPage({ params }: { params: Params }) {
  await assertReceiptsPageAccess();
  const { month } = await params;
  if (!/^\d{4}-\d{2}$/.test(month)) notFound();

  let composed;
  try {
    composed = await composeDelivery(month);
  } catch (error) {
    if (error instanceof NoSealedExportError) notFound();
    throw error;
  }

  return (
    <div className="px-8 py-8">
      <div className="mb-5">
        <Link
          href={`/receipts/export?month=${month}`}
          className="text-[12px] font-medium text-gray-500 hover:text-amber-700"
        >
          ‹ {formatMonthJa(month)} のエクスポートに戻る
        </Link>
      </div>
      <DeliveryComposer composed={composed} monthLabel={formatMonthJa(month)} />
    </div>
  );
}
