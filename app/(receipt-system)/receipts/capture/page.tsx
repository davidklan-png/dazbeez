import { ReceiptCaptureForm } from "@/components/receipts/receipt-capture-form";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { countCapturedSince, listRecentCaptures } from "@/lib/receipts/db";
import { startOfJstDayIso } from "@/lib/receipts/format";
import { resolveWorkMonth } from "@/lib/receipts/work-month";
import type { PaymentPath } from "@/lib/receipts/types";

export const dynamic = "force-dynamic";

// Supports shortcut URLs:
//   /receipts/capture?payment=AMEX   → preselect AMEX chip
//   /receipts/capture?payment=CASH   → preselect CASH chip
//   /receipts/capture?mode=rapid     → rapid mode (stay in capture after success)
//   /receipts/capture?month=YYYY-MM  → carried work month (preserved across nav)

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
  // The active work month (exact YYYY-MM) carried in from other receipts pages.
  // `all`/malformed/missing → null (nothing to propagate).
  const workMonth = resolveWorkMonth(
    typeof params.month === "string" ? params.month : null,
  );

  // Load the initial recent list and today's count in parallel on the server.
  // countCapturedToday() swallows DB errors → null ("—" in the mobile header).
  // The recent list is deliberately NOT swallowed: listRecentCaptures() throws
  // on DB failure so the page fails visibly rather than silently rendering an
  // authoritative empty rail for a transient DB error.
  const [todayCount, recentCaptures] = await Promise.all([
    countCapturedToday(),
    listRecentCaptures(),
  ]);

  return (
    <ReceiptCaptureForm
      initialPayment={initialPayment}
      rapidMode={rapidMode}
      workMonth={workMonth}
      todayCount={todayCount}
      recentCaptures={recentCaptures}
    />
  );
}

// Today's capture count, exact, from the start of the operator's JST day.
// Audit finding B1: previously returned 0 on DB error, which the mobile
// header rendered as a confident "0 today" — silently wrong. Now returns
// null and the UI shows "—" with a "count unavailable" title attr. Replaces
// the prior "load up to 200 rows and count in JavaScript" (over-read + UTC,
// not JST) with a single COUNT(*) bound to the JST day start.
async function countCapturedToday(): Promise<number | null> {
  try {
    return await countCapturedSince(startOfJstDayIso());
  } catch {
    return null;
  }
}
