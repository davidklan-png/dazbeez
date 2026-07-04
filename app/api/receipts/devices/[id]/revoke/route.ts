import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { isReceiptsOwner } from "@/lib/receipts/owners";
import {
  buildClearDeviceCookie,
  getCurrentDeviceId,
  revokeDevice,
  revokeDeviceById,
} from "@/lib/receipts/trusted-devices";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "Device id required." }, { status: 400 });
    }

    // Owners can revoke any device; everyone else only their own.
    if (isReceiptsOwner(actor)) {
      await revokeDeviceById(id);
    } else {
      await revokeDevice(id, actor);
    }

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
