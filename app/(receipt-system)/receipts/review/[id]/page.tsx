import { notFound } from "next/navigation";
import {
  getAmexMatchFlagsByReceiptIds,
  getReceiptRecord,
  listAttendees,
  listDistinctTransactionMonths,
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
import { CompliancePanel } from "@/components/receipts/CompliancePanel";
import {
  listChecksForObject,
  runComplianceChecksForReceipt,
} from "@/lib/receipts/compliance";
import { getComplianceSettings } from "@/lib/receipts/settings";
import { getExtractionHealth } from "@/lib/receipts/extraction-state";
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
  const { month: monthScope, includeUndated } = resolveReviewMonthScope(rawMonth);

  const [receipt, attendees, all] = await Promise.all([
    getReceiptRecord(id),
    listAttendees(id),
    listReceiptRecords({
      limit: RECEIPT_VIEW_LIMIT,
      month: monthScope,
      includeUndated,
    }),
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
  // the selected month (e.g. a deep link) — the form must never render
  // editable for a receipt the server would refuse to mutate.
  const locks = await getReceiptLocks(dedupeReceipts([receipt, ...all]));
  const activeLock = locks.get(receipt.id) ?? UNLOCKED_RECEIPT;

  const queue = filterReviewQueue(all, filter, {
    statusFilter,
    paymentPathFilter,
    locks,
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

  const queueItems = buildQueueItems(queue, reReviewIds, Date.now(), locks);
  const activeIndex = queueItems.findIndex((q) => q.id === id);
  const nextReceiptId = queueItems[activeIndex + 1]?.id ?? null;
  const prevReceiptId = queueItems[activeIndex - 1]?.id ?? null;

  const needsAttention = all.filter(
    (r) =>
      !locks.get(r.id)?.locked &&
      (r.status === "needs_review" || r.status === "captured"),
  ).length;
  const lockedCount = all.filter((r) => locks.get(r.id)?.locked).length;
  const ocrHealth = getExtractionHealth(all);

  const queryParams = buildReviewQueryParams(sp, monthParam);
  const availableMonths = await listDistinctTransactionMonths();
  const effectiveMonth = effectiveReviewMonth(monthParam, monthScope);

  const shortId = `R-${receipt.id.slice(0, 8)}`;

  return (
    <ReviewLayout
      queueItems={queueItems}
      activeId={id}
      queryParams={queryParams}
      needsAttention={needsAttention}
      workingSetCount={all.length}
      lockedCount={lockedCount}
      effectiveMonth={effectiveMonth}
      availableMonths={ensureCurrentMonth(availableMonths, effectiveMonth)}
      monthParam={monthParam}
      activeFilter={filter}
      ocrHealth={ocrHealth}
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
