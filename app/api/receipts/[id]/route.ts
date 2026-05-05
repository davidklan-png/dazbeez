import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders, getReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord, updateReceiptRecord, listAttendees, createAttendees, softDeleteReceipt } from "@/lib/receipts/db";
import type { CreateAttendeeInput, ExpenseType, PaymentPath, ReceiptStatus } from "@/lib/receipts/types";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const { id } = await params;

    const receipt = await getReceiptRecord(id);
    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    const attendees = await listAttendees(id);
    return NextResponse.json({ receipt, attendees }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]] GET failed", error);
    return NextResponse.json({ error: "Failed to load receipt." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);
    const { id } = await params;

    const receipt = await getReceiptRecord(id);
    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    if (receipt.status === "exported" || receipt.status === "archived") {
      return NextResponse.json(
        { error: `Receipt is ${receipt.status} and cannot be edited.` },
        { status: 409 },
      );
    }

    const body = (await request.json()) as {
      paymentPath?: string;
      expenseType?: string;
      transactionDate?: string | null;
      merchant?: string | null;
      amountMinor?: number | null;
      currency?: string;
      taxAmountMinor?: number | null;
      businessPurpose?: string | null;
      status?: string;
      attendees?: string[];
    };

    await updateReceiptRecord(
      id,
      {
        paymentPath: body.paymentPath as PaymentPath | undefined,
        expenseType: body.expenseType as ExpenseType | undefined,
        transactionDate: body.transactionDate,
        merchant: body.merchant,
        amountMinor: body.amountMinor,
        currency: body.currency,
        taxAmountMinor: body.taxAmountMinor,
        businessPurpose: body.businessPurpose,
        status: body.status as ReceiptStatus | undefined,
      },
      actor,
    );

    if (Array.isArray(body.attendees)) {
      const attendeeInputs: CreateAttendeeInput[] = body.attendees
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => ({ attendeeName: name.trim() }));
      await createAttendees(id, attendeeInputs, actor);
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]] PATCH failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Save failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);
    const { id } = await params;

    await softDeleteReceipt(id, actor);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof Error && error.message.includes("cannot be deleted")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }
    console.error("[api/receipts/[id]] DELETE failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed." },
      { status: 500 },
    );
  }
}
