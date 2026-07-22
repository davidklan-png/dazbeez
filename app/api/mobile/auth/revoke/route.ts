import { NextResponse } from "next/server";
import { revokeMobileDevice, verifyBearerDevice } from "@/lib/receipts/trusted-devices";

// Mobile-initiated revoke. Uses the bearer token itself to identify the
// device, so a stolen token cannot be used to revoke a different device.
// verifyBearerDevice only accepts platform ios|android rows whose actor
// matches the signed payload, so the device targeted here is always mobile.
export async function POST(request: Request) {
  try {
    const device = await verifyBearerDevice(request.headers);
    if (!device) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    await revokeMobileDevice(device.deviceId, device.actor);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[api/mobile/auth/revoke] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Revoke failed." },
      { status: 500 },
    );
  }
}
