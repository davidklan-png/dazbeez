import { notFound } from "next/navigation";
import { getReceiptRecord, listAttendees } from "@/lib/receipts/db";
import { ReceiptReviewForm } from "@/components/receipts/receipt-review-form";

export const dynamic = "force-dynamic";

export default async function ReviewReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const receipt = await getReceiptRecord(id);
  if (!receipt) notFound();

  const attendees = await listAttendees(id);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Review Receipt</h2>
        <p className="mt-1 text-sm text-gray-500">
          Verify and correct the receipt details before export.
        </p>
      </div>
      <ReceiptReviewForm receipt={receipt} initialAttendees={attendees} />
    </div>
  );
}
