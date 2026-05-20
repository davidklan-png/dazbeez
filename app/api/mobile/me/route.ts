import { NextResponse } from "next/server";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { verifyBearerDevice } from "@/lib/receipts/trusted-devices";

export async function GET(request: Request) {
  const device = await verifyBearerDevice(request.headers);
  if (!device) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const db = getReceiptsDb();
  const row = await db
    .prepare(
      `SELECT label, last_seen_at, created_at FROM trusted_devices WHERE id = ? LIMIT 1`,
    )
    .bind(device.deviceId)
    .first<{ label: string; last_seen_at: string | null; created_at: string }>();

  return NextResponse.json(
    {
      deviceId: device.deviceId,
      actor: device.actor,
      scopes: device.scopes,
      platform: device.platform,
      appVersion: device.appVersion,
      label: row?.label ?? null,
      lastSeenAt: row?.last_seen_at ?? null,
      createdAt: row?.created_at ?? null,
    },
    { status: 200 },
  );
}
