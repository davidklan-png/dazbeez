import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { getSenderControlsSnapshot } from "@/lib/receipts/sender-activity";

// Returns the authoritative sender-controls snapshot (trusted + blocked +
// unrecognized) so the Settings UI replaces all three lists atomically after
// every mutation. Clerk-gated.
export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const snapshot = await getSenderControlsSnapshot(getReceiptsDb());
    return NextResponse.json(snapshot, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/settings/sender-controls] GET failed", error);
    return NextResponse.json(
      { error: "Failed to load sender controls." },
      { status: 500 },
    );
  }
}
