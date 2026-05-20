import { NextResponse } from "next/server";
import { checkPairingCode } from "@/lib/receipts/mobile-pairing";

// Public endpoint polled by the iPhone with the pairing code it received from
// /start-pairing. Returns the bearer token exactly once after an operator
// completes pairing behind Cloudflare Access.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  }

  try {
    const result = await checkPairingCode(code);

    switch (result.status) {
      case "pending":
        return NextResponse.json({ ready: false }, { status: 200 });
      case "expired":
        return NextResponse.json({ ready: false, expired: true }, { status: 200 });
      case "not_found":
        return NextResponse.json({ error: "Unknown or already-redeemed code." }, { status: 404 });
      case "ready":
        return NextResponse.json(
          {
            ready: true,
            bearerToken: result.bearerToken,
            deviceId: result.deviceId,
          },
          { status: 200 },
        );
    }
  } catch (error) {
    console.error("[api/mobile/auth/check] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Check failed." },
      { status: 500 },
    );
  }
}
