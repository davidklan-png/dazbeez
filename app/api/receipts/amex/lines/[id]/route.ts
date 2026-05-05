import { NextResponse } from "next/server";
import { assertReceiptsAccessFromHeaders, getReceiptsActor } from "@/lib/receipts/auth";
import { updateAmexLineCategory } from "@/lib/receipts/db";
import type {
  AmexExpenseCategory,
  AmexCategoryStatus,
  AmexReceiptStatus,
  AmexBusinessTripStatus,
} from "@/lib/receipts/types";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const actor = await getReceiptsActor(request.headers);
    const { id } = await params;

    const body = (await request.json()) as {
      expenseCategory?: string;
      categoryStatus?: string;
      receiptStatus?: string;
      receiptMissingReason?: string | null;
      businessTripStatus?: string;
    };

    await updateAmexLineCategory(
      id,
      {
        expenseCategory: body.expenseCategory as AmexExpenseCategory | undefined,
        categoryStatus: body.categoryStatus as AmexCategoryStatus | undefined,
        receiptStatus: body.receiptStatus as AmexReceiptStatus | undefined,
        receiptMissingReason: body.receiptMissingReason,
        businessTripStatus: body.businessTripStatus as AmexBusinessTripStatus | undefined,
      },
      actor,
    );

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/amex/lines/[id]] PATCH failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Update failed." },
      { status: 500 },
    );
  }
}
