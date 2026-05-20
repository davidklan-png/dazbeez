import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { completePairing } from "@/lib/receipts/mobile-pairing";

// Cloudflare-Access-protected endpoint hit from the browser pairing page.
// Consumes the pairing code and enrolls the mobile device. The bearer token
// is NOT returned to the browser — it is stored on the pairing-codes row and
// picked up by the polling iPhone via /check.
export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      label?: string;
      platform?: "ios" | "android";
      appVersion?: string | null;
    };

    if (!body.code) {
      return NextResponse.json({ error: "code is required." }, { status: 400 });
    }
    const platform = body.platform === "android" ? "android" : "ios";
    const label = (body.label ?? "iPhone").slice(0, 80);
    const appVersion = body.appVersion?.slice(0, 32) ?? null;
    const userAgent = request.headers.get("user-agent")?.slice(0, 256) ?? null;

    const { deviceId } = await completePairing({
      code: body.code,
      actor,
      label,
      userAgent,
      platform,
      appVersion,
    });

    return NextResponse.json({ ok: true, deviceId }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (
      error instanceof Error &&
      /Pairing code|Invalid pairing/.test(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[api/mobile/auth/complete-pairing] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Pairing failed." },
      { status: 500 },
    );
  }
}
