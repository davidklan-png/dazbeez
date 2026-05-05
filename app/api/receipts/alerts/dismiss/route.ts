import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders, getReceiptsActor } from "@/lib/receipts/auth";
import { dismissAlert } from "@/lib/receipts/db";

export async function POST(request: Request) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);

    const body = (await request.json()) as {
      alertType?: string;
      alertKey?: string;
    };

    if (!body.alertType || !body.alertKey) {
      return NextResponse.json(
        { error: "alertType and alertKey are required." },
        { status: 400 },
      );
    }

    // For AMEX missing statement alerts, expiry is 7 days after the ready date
    // Compute ready date: alertKey is YYYY-MM statement month → ready on 18th of prior month
    const [year, month] = body.alertKey.split("-").map(Number) as [number, number];
    const readyDate = new Date(year, month - 2, 18); // prior month's 18th
    const expiresAt = new Date(readyDate.getTime() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    await dismissAlert(body.alertType, body.alertKey, actor, expiresAt);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/alerts/dismiss] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dismiss failed." },
      { status: 500 },
    );
  }
}
