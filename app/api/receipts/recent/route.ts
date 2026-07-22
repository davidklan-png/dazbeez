import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { listRecentCaptures } from "@/lib/receipts/db";
import { RECENT_CAPTURE_LIMIT } from "@/lib/receipts/recent-captures";

// Narrow, projected refresh endpoint for the Capture-page "Recent captures"
// rail. Returns only the small scalars the rail displays (no extraction_json,
// no SELECT *). Replaces polling the full-record GET /api/receipts endpoint,
// which would pull whole ReceiptRecord rows (including extraction_json) on
// every 15s tick. Authenticated via the same Clerk-gated actor check as the
// other receipts routes.

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const items = await listRecentCaptures(RECENT_CAPTURE_LIMIT);
    return NextResponse.json({ items }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/recent] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list recent captures." },
      { status: 500 },
    );
  }
}
