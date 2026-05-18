import { notFound } from "next/navigation";
import {
  getReceiptRecord,
  listAttendees,
  listReceiptRecords,
} from "@/lib/receipts/db";
import { assertReceiptsPageAccess } from "@/lib/receipts/auth-request";
import { ReviewLayout } from "@/components/receipts/review/review-layout";
import {
  QueueRail,
  buildQueueItems,
} from "@/components/receipts/review/queue-rail";
import { ImagePane } from "@/components/receipts/review/image-pane";
import { FormPane } from "@/components/receipts/review/form-pane";
import {
  InlineServerError,
  isNextInternalError,
} from "@/components/receipts/review/inline-error";

export const dynamic = "force-dynamic";

export default async function ReviewReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  try {
    return await renderReceiptPage(params);
  } catch (err) {
    if (isNextInternalError(err)) throw err;
    const { id } = await params.catch(() => ({ id: "?" }));
    console.error(`[receipts] /receipts/review/${id} render failed`, err);
    return (
      <InlineServerError where={`/receipts/review/${id}`} error={err} />
    );
  }
}

async function renderReceiptPage(params: Promise<{ id: string }>) {
  await assertReceiptsPageAccess();

  const { id } = await params;
  const [receipt, attendees, all] = await Promise.all([
    getReceiptRecord(id),
    listAttendees(id),
    listReceiptRecords({ limit: 200 }),
  ]);
  if (!receipt) notFound();

  const queueItems = buildQueueItems(all);
  const activeIndex = queueItems.findIndex((q) => q.id === id);
  const nextReceiptId = queueItems[activeIndex + 1]?.id ?? null;
  const prevReceiptId = queueItems[activeIndex - 1]?.id ?? null;

  const needsAttention = all.filter(
    (r) => r.status === "needs_review" || r.status === "captured",
  ).length;

  const shortId = `R-${receipt.id.slice(0, 8)}`;

  return (
    <ReviewLayout
      needsAttention={needsAttention}
      capturedThisMonth={all.length}
      queueRail={
        <QueueRail
          items={queueItems}
          activeId={id}
          totalUnreviewed={needsAttention}
          totalCaptured={all.length}
        />
      }
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
        <FormPane
          receipt={receipt}
          initialAttendees={attendees}
          queueIndex={Math.max(1, activeIndex + 1)}
          queueTotal={queueItems.length}
          nextReceiptId={nextReceiptId}
          prevReceiptId={prevReceiptId}
          hasAmexMatch={false}
        />
      }
    />
  );
}
