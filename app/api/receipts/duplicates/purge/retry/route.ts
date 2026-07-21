import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  getReceiptsDb,
  getReceiptsBucket,
  getReceiptsArchiveBucket,
} from "@/lib/cloudflare-runtime";
import { retryR2Cleanup, PurgeEligibilityError } from "@/lib/receipts/duplicate-purge";

// POST /api/receipts/duplicates/purge/retry
// Idempotent retry of R2 cleanup for a storage_failed / storage_pending purge
// tombstone. Already-absent objects are success. Never reports complete while an
// inventoried key remains.
export async function POST(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const body = (await request.json()) as { purgeJobId?: string };
    if (!body.purgeJobId) {
      return NextResponse.json({ error: "purgeJobId is required." }, { status: 400 });
    }
    const result = await retryR2Cleanup({
      db: getReceiptsDb(),
      receiptsBucket: getReceiptsBucket(),
      archiveBucket: getReceiptsArchiveBucket(),
      purgeJobId: body.purgeJobId,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof PurgeEligibilityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/receipts/duplicates/purge/retry] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Retry failed." },
      { status: 500 },
    );
  }
}
