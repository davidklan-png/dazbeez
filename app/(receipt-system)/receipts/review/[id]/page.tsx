import { notFound } from "next/navigation";
import {
  getAmexMatchFlagsByReceiptIds,
  getReceiptRecord,
  listAttendees,
  listDistinctTransactionMonths,
  listAmexLineCountsByMonth,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { RECEIPT_VIEW_LIMIT } from "@/lib/receipts/list-policy";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { ReviewLayout } from "@/components/receipts/review/review-layout";
import { buildQueueItems } from "@/lib/receipts/queue-items";
import { ImagePane } from "@/components/receipts/review/image-pane";
import { FormPane } from "@/components/receipts/review/form-pane";
import { listOpenExportMonths, naturalMonthForDate } from "@/lib/receipts/membership";
import { getReceiptLocks, UNLOCKED_RECEIPT } from "@/lib/receipts/receipt-locks";
import { collectClosingAttentionReceiptIds } from "@/lib/receipts/review-attention";
import { loadClosingScopeWorkingSet } from "@/lib/receipts/review-scope";
import { DEFAULT_SORT, sortQueueItems } from "@/lib/receipts/queue-sort";
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
import { CompliancePanel } from "@/components/receipts/CompliancePanel";
import {
  listChecksForObject,
  runComplianceChecksForReceipt,
} from "@/lib/receipts/compliance";
import { getComplianceSettings } from "@/lib/receipts/settings";
import { listCategoryRules } from "@/lib/receipts/category-rules";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import type { ReceiptRecord } from "@/lib/receipts/types";

export const dynamic = "force-dynamic";

export default async function ReviewReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    return await renderReceiptPage(params, searchParams);
  } catch (err) {
    if (isNextInternalError(err)) throw err;
    const { id } = await params.catch(() => ({ id: "?" }));
    console.error(`[receipts] /receipts/review/${id} render failed`, err);
    return (
      <InlineServerError where={`/receipts/review/${id}`} error={err} />
    );
  }
}

async function renderReceiptPage(
  params: Promise<{ id: string }>,
  searchParams: Promise<Record<string, string | string[] | undefined>>,
) {
  await assertReceiptsPageAccess();

  const { id } = await params;
  const sp = await searchParams;
  const filter = String(sp.filter ?? "");
  const statusFilter = typeof sp.status === "string" ? sp.status : undefined;
  const paymentPathFilter =
    typeof sp.payment_path === "string" ? sp.payment_path : undefined;
  const rawMonth = typeof sp.month === "string" ? sp.month : undefined;
  const monthParam = rawMonth ?? "";
  const rawScope = typeof sp.scope === "string" ? sp.scope : undefined;
  const scope: ReviewScope = resolveReviewScope(rawScope, monthParam);
  const { month: monthScope, includeUndated } = resolveReviewMonthScope(rawMonth);

  // Working set: closing-scope membership (export authority) vs calendar month.
  let workingReceipts: ReceiptRecord[];
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

  const [receipt, attendees] = await Promise.all([
    getReceiptRecord(id),
    listAttendees(id),
  ]);
  if (!receipt) notFound();

  // ADR 0008 (reusing 0006 §D6): open export months (override targets) + the
  // receipt's natural calendar month, for the discretionary membership override
  // control.
  const [overrideTargetMonths, naturalStatementMonth] = await Promise.all([
    listOpenExportMonths(),
    naturalMonthForDate(receipt.transaction_date),
  ]);

  // Compute compliance checks fresh on render so the panel always reflects
  // the current state (track_tax_breakdown toggle, backfilled manifest rows,
  // etc.) — without this, checks only recompute inside the PATCH handler and
  // the panel reads stale rows until a full page reload. Engine failure
  // falls back to the existing list rather than 500-ing the page.
  let complianceChecks = await listChecksForObject(
    getReceiptsDb(),
    "receipt",
    id,
  );
  try {
    const settings = await getComplianceSettings();
    await runComplianceChecksForReceipt(getReceiptsDb(), id, settings);
    complianceChecks = await listChecksForObject(
      getReceiptsDb(),
      "receipt",
      id,
    );
  } catch (err) {
    console.error(
      `[receipts] compliance re-run failed for ${id}, serving stale list`,
      err,
    );
  }

  // Locks are computed over the union of the active receipt and the queue set,
  // so the active receipt's lock is always known even when it lands outside
  // the selected scope (e.g. a deep link) — the form must never render
  // editable for a receipt the server would refuse to mutate.
  const locks = await getReceiptLocks(dedupeReceipts([receipt, ...workingReceipts]));
  const activeLock = locks.get(receipt.id) ?? UNLOCKED_RECEIPT;

  const attentionIds = await collectClosingAttentionReceiptIds(workingReceipts);
  const queue = filterReviewQueue(workingReceipts, filter, {
    statusFilter,
    paymentPathFilter,
    locks,
    attentionIds,
    scope,
    amexMatchedIds,
  });

  const amexFlags = await getAmexMatchFlagsByReceiptIds(
    queue.map((r) => r.id).concat(queue.some((r) => r.id === id) ? [] : [id]),
  );
  const reReviewIds = new Set(
    [...amexFlags.entries()]
      .filter(([, f]) => f.reReviewNeeded)
      .map(([rid]) => rid),
  );
  const activeFlags = amexFlags.get(id);

  // Server-side default sort matches the hydrated client (date-asc, undated
  // last) so the next/prev fallback follows the same order as the sorted rail.
  const queueItems = sortQueueItems(
    buildQueueItems(queue, reReviewIds, Date.now(), locks),
    DEFAULT_SORT,
  );
  const activeIndex = queueItems.findIndex((q) => q.id === id);
  const nextReceiptId = queueItems[activeIndex + 1]?.id ?? null;
  const prevReceiptId = queueItems[activeIndex - 1]?.id ?? null;

  const needsAttention = workingReceipts.filter(
    (r) => !locks.get(r.id)?.locked && attentionIds.has(r.id),
  ).length;

  const queryParams = buildReviewQueryParams(sp, monthParam, scope);
  const effectiveMonth = effectiveReviewMonth(monthParam, monthScope);
  const [receiptMonths, amexLineCounts] = await Promise.all([
    listDistinctTransactionMonths(),
    listAmexLineCountsByMonth(),
  ]);
  const availableMonths = ensureCurrentMonth(
    mergeMonthOptions(receiptMonths, [...amexLineCounts.keys()], effectiveMonth),
    effectiveMonth,
  );

  // Category pattern rules → form-pane suggestion affordance (ADR: category-rules).
  const categoryRules = (await listCategoryRules(getReceiptsDb())).map((r) => ({
    matchType: r.match_type,
    matchValue: r.match_value,
    expenseCategoryCode: r.expense_category_code,
  }));

  const shortId = `R-${receipt.id.slice(0, 8)}`;

  return (
    <ReviewLayout
      queueItems={queueItems}
      activeId={id}
      queryParams={queryParams}
      needsAttention={needsAttention}
      workingSetCount={workingReceipts.length}
      effectiveMonth={effectiveMonth}
      availableMonths={availableMonths}
      monthParam={monthParam}
      activeFilter={filter}
      scope={scope}
      imagePane={
        <ImagePane
          receiptId={receipt.id}
          receiptDisplayId={shortId}
          filename={receipt.original_filename}
          fileSizeBytes={receipt.original_size_bytes}
          contentType={receipt.original_content_type}
          hasExtraction={Boolean(receipt.extraction_json)}
        />
      }
      formPane={
        <div className="space-y-4">
          <CompliancePanel checks={complianceChecks} />
          <FormPane
            receipt={receipt}
            initialAttendees={attendees}
            queueIndex={Math.max(1, activeIndex + 1)}
            queueTotal={queueItems.length}
            nextReceiptId={nextReceiptId}
            prevReceiptId={prevReceiptId}
            hasAmexMatch={activeFlags?.hasMatch ?? false}
            reReviewNeeded={activeFlags?.reReviewNeeded ?? false}
            overrideTargetMonths={overrideTargetMonths}
            naturalStatementMonth={naturalStatementMonth}
            lock={activeLock}
            categoryRules={categoryRules}
          />
        </div>
      }
    />
  );
}

/** De-duplicate so the active receipt (which may already be in the queue) is
 *  not computed twice by getReceiptLocks. */
function dedupeReceipts(receipts: ReceiptRecord[]): ReceiptRecord[] {
  const seen = new Set<string>();
  const out: ReceiptRecord[] = [];
  for (const r of receipts) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}
