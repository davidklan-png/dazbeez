import { ReceiptCaptureForm } from "@/components/receipts/receipt-capture-form";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { listReceiptRecords } from "@/lib/receipts/db";
import type { PaymentPath } from "@/lib/receipts/types";

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
  await assertReceiptsPageAccess();

  const params = await searchParams;
  const rawPayment = String(params.payment ?? "").toUpperCase();
  const initialPayment: PaymentPath | null =
    rawPayment === "AMEX"
      ? "AMEX"
      : rawPayment === "CASH"
        ? "CASH"
        : rawPayment === "DIGITAL"
          ? "DIGITAL"
          : null;
  const rapidMode = String(params.mode ?? "") === "rapid";

  const todayCount = await countCapturedToday();

  return (
    <ReceiptCaptureForm
      initialPayment={initialPayment}
      rapidMode={rapidMode}
      todayCount={todayCount}
    />
  );
}

async function countCapturedToday(): Promise<number> {
  try {
    const rows = await listReceiptRecords({ limit: 200 });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startIso = startOfDay.toISOString();
    return rows.filter((r) => r.captured_at >= startIso).length;
  } catch {
    return 0;
  }
}
