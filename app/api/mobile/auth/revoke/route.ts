import { NextResponse } from "next/server";
import { revokeDevice, verifyBearerDevice } from "@/lib/receipts/trusted-devices";

// iPhone-initiated revoke. Uses the bearer token itself to identify the
// device, so a stolen token cannot be used to revoke a different device.
export async function POST(request: Request) {
  try {
    const device = await verifyBearerDevice(request.headers);
    if (!device) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    await revokeDevice(device.deviceId, device.actor);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[api/mobile/auth/revoke] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Revoke failed." },
      { status: 500 },
    );
  }
}
