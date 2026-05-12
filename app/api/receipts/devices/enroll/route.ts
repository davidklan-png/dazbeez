import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { enrollDevice } from "@/lib/receipts/trusted-devices";

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const body = (await request.json().catch(() => ({}))) as { label?: string };
    const label = body.label?.trim();
    if (!label || label.length > 64) {
      return NextResponse.json(
        { error: "Device label is required (max 64 chars)." },
        { status: 400 },
      );
    }

    const userAgent = request.headers.get("user-agent");
    const { id, cookie } = await enrollDevice({
      actor,
      label,
      userAgent: userAgent ? userAgent.slice(0, 256) : null,
    });

    return new NextResponse(
      JSON.stringify({ ok: true, deviceId: id }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": cookie,
        },
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/devices/enroll] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Enrollment failed." },
      { status: 500 },
    );
  }
}
