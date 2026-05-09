import { NextResponse } from "next/server";
import {
  assertReceiptsAccessFromHeaders,
  getReceiptsActor,
} from "@/lib/receipts/auth";
import {
  buildClearDeviceCookie,
  getCurrentDeviceId,
  revokeDevice,
} from "@/lib/receipts/trusted-devices";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "Device id required." }, { status: 400 });
    }

    await revokeDevice(id, actor);

    const currentDeviceId = await getCurrentDeviceId(request.headers);
    const isCurrent = currentDeviceId === id;

    return new NextResponse(JSON.stringify({ ok: true, revokedSelf: isCurrent }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...(isCurrent ? { "Set-Cookie": buildClearDeviceCookie() } : {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/devices/:id/revoke] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Revoke failed." },
      { status: 500 },
    );
  }
}
