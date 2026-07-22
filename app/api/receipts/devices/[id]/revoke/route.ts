import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { isReceiptsOwner } from "@/lib/receipts/owners";
import {
  revokeMobileDevice,
  revokeMobileDeviceById,
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

    // Owners can revoke any paired mobile device; everyone else only their own.
    // Both revoke paths constrain platform to ios|android, so a guessed
    // historical browser row id is never revoked here.
    if (await isReceiptsOwner(actor)) {
      await revokeMobileDeviceById(id);
    } else {
      await revokeMobileDevice(id, actor);
    }

    return NextResponse.json({ ok: true }, { status: 200 });
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
