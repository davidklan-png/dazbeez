import { NextResponse, type NextRequest } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

/**
 * Fire-and-forget endpoint hit by /nfc when a `src` query param is present.
 * We don't have an analytics pipeline yet, so this just logs the tap
 * source. Stays a no-op response so `navigator.sendBeacon` succeeds.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const src = (url.searchParams.get("src") || "").slice(0, 64);
  if (src) {
    // Logged so it shows up in worker tail. Replace with a real analytics
    // sink (D1 / Cloudflare Analytics) when we add tap reporting.
    console.log(JSON.stringify({ evt: "nfc.hit", src }));
  }
  return new NextResponse(null, { status: 204 });
}
