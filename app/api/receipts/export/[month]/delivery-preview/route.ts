import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  composeDelivery,
  NoSealedExportError,
  type ComposedDelivery,
} from "@/lib/receipts/delivery-compose";

type RouteContext = { params: Promise<{ month: string }> };

/**
 * GET /api/receipts/export/{month}/delivery-preview
 *
 * Returns the composed delivery (recipients, subject, body, attachment sha/size,
 * preflight, send decision) for a sealed month — the SAME {@link composeDelivery}
 * the send route and the composer page use, so preview and send cannot disagree.
 *
 * Clerk-protected like the rest of /api/receipts/* (matched via
 * /api/receipts/:path*, NOT in PUBLIC_ROUTES — asserted in the middleware-routing
 * test). 400 on a malformed month, 404 when no sealed export exists for the
 * month. The response carries no secret (no API key); `from` is the configured
 * sender address.
 */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireReceiptsActor(request.headers);
    const { month } = await params;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "Invalid month format." },
        { status: 400 },
      );
    }
    const composed: ComposedDelivery = await composeDelivery(month);
    return NextResponse.json(composed, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof NoSealedExportError) {
      return NextResponse.json(
        { error: "No sealed export for this month. Finalize before sending." },
        { status: 404 },
      );
    }
    console.error("[api/receipts/export/[month]/delivery-preview] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to compose delivery." },
      { status: 500 },
    );
  }
}
