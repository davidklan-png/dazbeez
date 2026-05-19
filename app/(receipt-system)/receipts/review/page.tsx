import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getAmexMatchFlagsByReceiptIds,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { ReviewLayout } from "@/components/receipts/review/review-layout";
import { QueueRail } from "@/components/receipts/review/queue-rail";
import { buildQueueItems } from "@/lib/receipts/queue-items";
import {
  InlineServerError,
  isNextInternalError,
} from "@/components/receipts/review/inline-error";
import type { ReceiptRecord } from "@/lib/receipts/types";

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

  const receipts = await listReceiptRecords({ limit: 200 });
  const queue = filterQueue(receipts, filter);
  const amexFlags = await getAmexMatchFlagsByReceiptIds(queue.map((r) => r.id));
  const reReviewIds = new Set(
    [...amexFlags.entries()]
      .filter(([, f]) => f.reReviewNeeded)
      .map(([rid]) => rid),
  );
  const queueItems = buildQueueItems(queue, reReviewIds);
  const needsAttention = queue.filter(
    (r) => r.status === "needs_review" || r.status === "captured",
  ).length;

  if (queueItems.length > 0 && filter === "") {
    redirect(`/receipts/review/${queueItems[0].id}`);
  }

  return (
    <ReviewLayout
      activeFilter={filter}
      needsAttention={needsAttention}
      capturedThisMonth={receipts.length}
      queueRail={
        <QueueRail
          items={queueItems}
          activeId={null}
          totalUnreviewed={needsAttention}
          totalCaptured={receipts.length}
        />
      }
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

function filterQueue(receipts: ReceiptRecord[], filter: string) {
  if (filter === "reviewed") {
    return receipts.filter((r) => r.status === "reviewed");
  }
  if (filter === "needs") {
    return receipts.filter(
      (r) => r.status === "needs_review" || r.status === "captured",
    );
  }
  if (filter === "attendees" || filter === "purpose") {
    return receipts.filter(
      (r) =>
        (r.status === "needs_review" || r.status === "captured") &&
        !r.business_purpose,
    );
  }
  return receipts;
}
