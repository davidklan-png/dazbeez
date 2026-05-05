import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders } from "@/lib/receipts/auth";
import { listReceiptRecords } from "@/lib/receipts/db";

export async function GET(request: Request) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);

    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const month = url.searchParams.get("month") ?? undefined;
    const paymentPath = url.searchParams.get("paymentPath") ?? undefined;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 200);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const records = await listReceiptRecords({
      status,
      month,
      paymentPath,
      limit,
      offset,
    });

    return NextResponse.json({ receipts: records }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list receipts." },
      { status: 500 },
    );
  }
}
