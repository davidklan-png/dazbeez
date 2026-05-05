import Link from "next/link";
import { ReceiptCaptureForm } from "@/components/receipts/receipt-capture-form";
import type { PaymentChip } from "@/components/receipts/receipt-drop-button";

export const dynamic = "force-dynamic";

// Supports shortcut URLs:
//   /receipts/capture?payment=AMEX   → preselect AMEX chip
//   /receipts/capture?payment=CASH   → preselect CASH chip
//   /receipts/capture?mode=rapid     → rapid mode (stay in capture after success)

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawPayment = String(params.payment ?? "").toUpperCase();
  const initialPayment: PaymentChip =
    rawPayment === "AMEX" ? "AMEX" : rawPayment === "CASH" ? "CASH" : null;
  const rapidMode = String(params.mode ?? "") === "rapid";

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-semibold text-gray-900">Capture Receipt</h2>
        <p className="mt-1 text-sm text-gray-400">
          Take the picture now — add details later.
        </p>
      </div>

      <ReceiptCaptureForm
        initialPayment={initialPayment}
        rapidMode={rapidMode}
      />

      <div className="text-center">
        <Link
          href="/receipts/review"
          className="text-xs text-gray-400 underline hover:text-gray-600"
        >
          View review queue
        </Link>
      </div>
    </div>
  );
}
