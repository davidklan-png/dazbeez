import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { listReceiptRecords } from "@/lib/receipts/db";

function intOrUndef(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);

    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const month = url.searchParams.get("month") ?? undefined;
    const paymentPath = url.searchParams.get("paymentPath") ?? undefined;
    const sourceType = url.searchParams.get("sourceType") ?? undefined;
    const qualifiedInvoiceStatus =
      url.searchParams.get("qualifiedInvoiceStatus") ?? undefined;
    const merchant = url.searchParams.get("merchant") ?? undefined;
    const invoiceRegistrationNumber =
      url.searchParams.get("invoiceRegistrationNumber") ?? undefined;
    const minAmountMinor = intOrUndef(url.searchParams.get("minAmountMinor"));
    const maxAmountMinor = intOrUndef(url.searchParams.get("maxAmountMinor"));
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 200);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const records = await listReceiptRecords({
      status,
      month,
      paymentPath,
      sourceType,
      qualifiedInvoiceStatus,
      merchant,
      invoiceRegistrationNumber,
      minAmountMinor,
      maxAmountMinor,
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
