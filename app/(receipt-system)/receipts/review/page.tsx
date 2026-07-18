import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getAmexMatchFlagsByReceiptIds,
  listDistinctTransactionMonths,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { RECEIPT_VIEW_LIMIT } from "@/lib/receipts/list-policy";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { ReviewLayout } from "@/components/receipts/review/review-layout";
import { buildQueueItems } from "@/lib/receipts/queue-items";
import { getExtractionHealth } from "@/lib/receipts/extraction-state";
import { getReceiptLocks } from "@/lib/receipts/receipt-locks";
import {
  buildReviewQueryParams,
  effectiveReviewMonth,
  ensureCurrentMonth,
  filterReviewQueue,
  resolveReviewMonthScope,
} from "@/lib/receipts/review-queue-filter";
import {
  InlineServerError,
  isNextInternalError,
} from "@/components/receipts/review/inline-error";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    return await renderReviewPage(searchParams);
  } catch (err) {
    if (isNextInternalError(err)) throw err;
    console.error("[receipts] /receipts/review render failed", err);
    return <InlineServerError where="/receipts/review" error={err} />;
  }
}

async function renderReviewPage(
  searchParams: Promise<Record<string, string | string[] | undefined>>,
) {
  await assertReceiptsPageAccess();

  const params = await searchParams;
  const filter = String(params.filter ?? "");
  const statusFilter =
    typeof params.status === "string" ? params.status : undefined;
  const paymentPathFilter =
    typeof params.payment_path === "string" ? params.payment_path : undefined;

  // Month scope (hybrid model: month/lock server-side, sort/search client-side).
  // '' = default (current calendar month), 'all' = 200 most recent, else YYYY-MM.
  const rawMonth = typeof params.month === "string" ? params.month : undefined;
  const monthParam = rawMonth ?? "";
  const { month: monthScope, includeUndated } = resolveReviewMonthScope(rawMonth);

  const receipts = await listReceiptRecords({
    limit: RECEIPT_VIEW_LIMIT,
    month: monthScope,
    includeUndated,
  });
  const locks = await getReceiptLocks(receipts);
  const queue = filterReviewQueue(receipts, filter, {
    statusFilter,
    paymentPathFilter,
    locks,
  });

  const amexFlags = await getAmexMatchFlagsByReceiptIds(queue.map((r) => r.id));
  const reReviewIds = new Set(
    [...amexFlags.entries()]
      .filter(([, f]) => f.reReviewNeeded)
      .map(([rid]) => rid),
  );
  const queueItems = buildQueueItems(queue, reReviewIds, Date.now(), locks);

  const needsAttention = receipts.filter(
    (r) =>
      !locks.get(r.id)?.locked &&
      (r.status === "needs_review" || r.status === "captured"),
  ).length;
  const lockedCount = receipts.filter((r) => locks.get(r.id)?.locked).length;

  // Bare URL (no params at all) → rapid-review entry point: jump to the first
  // unlocked item. Never redirect when a month/filter param is set.
  const hasAnyParam = Boolean(rawMonth || filter || statusFilter || paymentPathFilter);
  if (queueItems.length > 0 && !hasAnyParam) {
    redirect(`/receipts/review/${queueItems[0].id}`);
  }

  const queryParams = buildReviewQueryParams(params, monthParam);
  const availableMonths = await listDistinctTransactionMonths();
  const effectiveMonth = effectiveReviewMonth(monthParam, monthScope);

  return (
    <ReviewLayout
      queueItems={queueItems}
      activeId={null}
      queryParams={queryParams}
      needsAttention={needsAttention}
      workingSetCount={receipts.length}
      lockedCount={lockedCount}
      effectiveMonth={effectiveMonth}
      availableMonths={ensureCurrentMonth(availableMonths, effectiveMonth)}
      monthParam={monthParam}
      activeFilter={filter}
      ocrHealth={getExtractionHealth(receipts)}
      imagePane={
        <div className="flex h-full items-center justify-center bg-gray-100 text-sm text-gray-400">
          Select a receipt from the queue.
        </div>
      }
      formPane={
        <div className="flex h-full items-center justify-center bg-white p-10 text-center text-sm text-gray-500">
          <div className="max-w-xs">
            {queueItems.length === 0 ? (
              <>
                <div className="text-base font-semibold text-gray-700">
                  Inbox zero
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Nothing matches this filter. Capture more or change filter.
                </p>
                <Link
                  href="/receipts/capture?mode=rapid"
                  className="mt-4 inline-block rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-600"
                >
                  Capture a receipt
                </Link>
              </>
            ) : (
              <>
                <div className="text-base font-semibold text-gray-700">
                  Select a receipt
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  Use <span className="font-semibold">j / k</span> or click the
                  queue.
                </p>
              </>
            )}
          </div>
        </div>
      }
    />
  );
}
