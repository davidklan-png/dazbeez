import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getAmexMatchFlagsByReceiptIds,
  listAmexLineCountsByMonth,
  listDistinctTransactionMonths,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { RECEIPT_VIEW_LIMIT } from "@/lib/receipts/list-policy";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { ReviewLayout } from "@/components/receipts/review/review-layout";
import { buildQueueItems } from "@/lib/receipts/queue-items";
import { getReceiptLocks } from "@/lib/receipts/receipt-locks";
import { collectClosingAttentionReceiptIds } from "@/lib/receipts/review-attention";
import { loadClosingScopeWorkingSet } from "@/lib/receipts/review-scope";
import { DEFAULT_SORT, sortQueueItems } from "@/lib/receipts/queue-sort";
import { resolveWorkMonth, withWorkMonth } from "@/lib/receipts/work-month";
import {
  buildReviewQueryParams,
  effectiveReviewMonth,
  ensureCurrentMonth,
  filterReviewQueue,
  isConcreteMonth,
  mergeMonthOptions,
  resolveReviewMonthScope,
  resolveReviewScope,
  type ReviewScope,
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

  // Month + scope (hybrid model: month/scope/lock/attention server-side, sort
  // client-side). month '' = current calendar month, 'all' = recent window,
  // else YYYY-MM. scope 'closing' (only valid for a concrete month) shows the
  // monthly export/finalize membership instead of the transaction-date month.
  const rawMonth = typeof params.month === "string" ? params.month : undefined;
  const monthParam = rawMonth ?? "";
  // Concrete work month (exact YYYY-MM) carried into cross-page links from this
  // view. `all`/malformed/missing → null (nothing to propagate).
  const workMonth = resolveWorkMonth(rawMonth);
  const rawScope = typeof params.scope === "string" ? params.scope : undefined;
  const scope: ReviewScope = resolveReviewScope(rawScope, monthParam);
  const { month: monthScope, includeUndated } = resolveReviewMonthScope(rawMonth);

  // Working set: closing-scope membership (export authority) vs the calendar
  // transaction-date month. Closing scope reuses buildExportBundle(M).receipts
  // + listUnknownInScopeReceipts(M) so the queue cannot drift from what ships.
  let workingReceipts;
  let amexMatchedIds: Set<string> | undefined;
  if (scope === "closing" && isConcreteMonth(monthParam)) {
    const workingSet = await loadClosingScopeWorkingSet(monthParam);
    workingReceipts = workingSet.receipts;
    amexMatchedIds = workingSet.amexMatchedIds;
  } else {
    workingReceipts = await listReceiptRecords({
      limit: RECEIPT_VIEW_LIMIT,
      month: monthScope,
      includeUndated,
    });
  }

  const locks = await getReceiptLocks(workingReceipts);
  const attentionIds = await collectClosingAttentionReceiptIds(workingReceipts);
  const queue = filterReviewQueue(workingReceipts, filter, {
    statusFilter,
    paymentPathFilter,
    locks,
    attentionIds,
    scope,
    amexMatchedIds,
  });

  const amexFlags = await getAmexMatchFlagsByReceiptIds(queue.map((r) => r.id));
  const reReviewIds = new Set(
    [...amexFlags.entries()]
      .filter(([, f]) => f.reReviewNeeded)
      .map(([rid]) => rid),
  );
  // Server-side default sort matches the hydrated client (date-asc, undated
  // last) so the bare-URL redirect + next/prev fallback land on the same row
  // the sorted rail shows.
  const queueItems = sortQueueItems(
    buildQueueItems(queue, reReviewIds, Date.now(), locks),
    DEFAULT_SORT,
  );

  // Amber need-attention count = unlocked working-set receipts in the shared
  // closing-attention set. Exactly the Needs review tab's count for this scope.
  const needsAttention = workingReceipts.filter(
    (r) => !locks.get(r.id)?.locked && attentionIds.has(r.id),
  ).length;

  // Bare URL (no params at all) → rapid-review entry point: jump to the first
  // (earliest) unlocked item. Any explicit month/scope/filter param suppresses
  // the redirect.
  const hasAnyParam = Boolean(
    rawMonth || filter || statusFilter || paymentPathFilter || rawScope,
  );
  if (queueItems.length > 0 && !hasAnyParam) {
    redirect(`/receipts/review/${queueItems[0]!.id}`);
  }

  const queryParams = buildReviewQueryParams(params, monthParam, scope);
  const effectiveMonth = effectiveReviewMonth(monthParam, monthScope);
  const [receiptMonths, amexLineCounts] = await Promise.all([
    listDistinctTransactionMonths(),
    listAmexLineCountsByMonth(),
  ]);
  const availableMonths = ensureCurrentMonth(
    mergeMonthOptions(receiptMonths, [...amexLineCounts.keys()], effectiveMonth),
    effectiveMonth,
  );

  return (
    <ReviewLayout
      queueItems={queueItems}
      activeId={null}
      queryParams={queryParams}
      needsAttention={needsAttention}
      workingSetCount={workingReceipts.length}
      effectiveMonth={effectiveMonth}
      availableMonths={availableMonths}
      monthParam={monthParam}
      activeFilter={filter}
      scope={scope}
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
                  href={withWorkMonth("/receipts/capture?mode=rapid", workMonth)}
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
