import { listReceiptRecords } from "@/lib/receipts/db";
import { ReceiptReviewTable } from "@/components/receipts/receipt-review-table";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const receipts = await listReceiptRecords({ limit: 50 });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Review Queue</h2>
        <p className="mt-1 text-sm text-gray-500">
          {receipts.length} receipt{receipts.length !== 1 ? "s" : ""} captured.
        </p>
      </div>

      <ReceiptReviewTable receipts={receipts} />
    </div>
  );
}
